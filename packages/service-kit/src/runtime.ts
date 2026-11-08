import { readFileSync } from 'node:fs';
import { serviceCatalog } from '@atlas/contracts';
import { createLogger, startTracing, type Logger } from '@atlas/observability';
import type { z } from '@atlas/schemas';
import { ConfigurationError } from '@atlas/shared';
import type { FastifyInstance } from 'fastify';
import { buildServiceApp } from './app.js';
import { loadServiceConfig } from './config.js';
import { createPostgresConnector } from './connectors/postgres.js';
import { createRabbitMqConnector } from './connectors/rabbitmq.js';
import { createValkeyConnector } from './connectors/valkey.js';
import { ReadinessRegistry } from './health.js';
import type {
  Infrastructure,
  ServiceConfig,
  ServiceContext,
  ServiceDefinition,
} from './service.js';

export interface RunningService<TShape extends z.ZodRawShape> {
  app: FastifyInstance;
  context: ServiceContext<ServiceConfig<TShape>>;
  /** Starts listening. Resolves with the bound address. */
  start(): Promise<string>;
  /** Graceful shutdown: stop accepting work, drain in-flight requests, release connections. */
  stop(): Promise<void>;
}

/** Reads "version" from the package.json one directory above the calling module (src/ or dist/). */
export function readPackageVersion(moduleUrl: string): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', moduleUrl), 'utf8')) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Creates a service instance from its definition and an environment. Separated from
 * runService() so tests can create, start and stop real instances in-process.
 */
export async function createService<TShape extends z.ZodRawShape>(
  definition: ServiceDefinition<TShape>,
  env: Readonly<Record<string, string | undefined>>,
  options: { logger?: Logger } = {},
): Promise<RunningService<TShape>> {
  const config = loadServiceConfig(
    definition.name,
    definition.dependencies,
    definition.configShape ?? ({} as TShape),
    env,
  );
  const logger =
    options.logger ??
    createLogger({
      service: definition.name,
      version: definition.version,
      environment: config.ATLAS_ENV,
      level: config.LOG_LEVEL,
      pretty: config.LOG_PRETTY,
    });

  const metadata = {
    name: definition.name,
    version: definition.version,
    apiVersions: definition.apiVersions ?? ['v1'],
    startedAt: new Date(),
  };
  const readiness = new ReadinessRegistry();
  const infrastructure: Infrastructure = {};
  const catalogue = serviceCatalog[definition.name];
  const connectionName = `${definition.name}@${definition.version}`;

  if (config.DATABASE_URL) {
    infrastructure.postgres = createPostgresConnector({
      url: config.DATABASE_URL,
      applicationName: connectionName,
      logger,
    });
    readiness.register('postgres', infrastructure.postgres.check);
  }
  if (config.VALKEY_URL) {
    infrastructure.valkey = createValkeyConnector({
      url: config.VALKEY_URL,
      keyPrefix: catalogue.dataStores.valkeyPrefix ?? `atlas:${definition.name}:`,
      connectionName,
      logger,
    });
    readiness.register('valkey', infrastructure.valkey.check);
  }
  if (config.RABBITMQ_URL) {
    infrastructure.rabbitmq = createRabbitMqConnector({
      url: config.RABBITMQ_URL,
      connectionName,
      logger,
    });
    readiness.register('rabbitmq', infrastructure.rabbitmq.check);
  }

  const context: ServiceContext<ServiceConfig<TShape>> = {
    config: config as ServiceConfig<TShape>,
    logger,
    metadata,
    infrastructure,
    readiness,
  };

  const app = await buildServiceApp({ config, logger, metadata, readiness });
  await definition.register?.(app, context);

  // Connections are released after the HTTP server has drained.
  app.addHook('onClose', async () => {
    await Promise.allSettled(
      [infrastructure.postgres, infrastructure.valkey, infrastructure.rabbitmq].map((connector) =>
        connector?.close(),
      ),
    );
  });

  let stopping: Promise<void> | undefined;
  return {
    app,
    context,
    async start() {
      const address = await app.listen({ host: config.HOST, port: config.PORT });
      logger.info({ address, dependencies: definition.dependencies }, 'service started');
      return address;
    },
    stop() {
      stopping ??= (async () => {
        readiness.markShuttingDown();
        logger.info('service stopping');
        await app.close();
        logger.info('service stopped');
      })();
      return stopping;
    },
  };
}

/**
 * Process entry point for a service: validates configuration, starts tracing and the server,
 * and wires SIGTERM/SIGINT to graceful shutdown with a hard timeout.
 *
 * Exit codes: 0 clean shutdown · 1 startup failure, invalid configuration or forced shutdown.
 */
export async function runService<TShape extends z.ZodRawShape>(
  definition: ServiceDefinition<TShape>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  let service: RunningService<TShape>;
  try {
    service = await createService(definition, env);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // Logger may not be configurable yet; emit one JSON line naming the invalid keys only.
      process.stderr.write(
        `${JSON.stringify({
          level: 'fatal',
          service: definition.name,
          message: 'invalid configuration; refusing to start',
          issues: error.issues,
        })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { config, logger } = service.context;
  const tracing = startTracing({
    service: definition.name,
    version: definition.version,
    environment: config.ATLAS_ENV,
    otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  const shutdown = async (reason: string, exitCode: number) => {
    logger.info({ reason }, 'shutdown requested');
    const timer = setTimeout(() => {
      logger.error(
        { timeoutMs: config.SHUTDOWN_TIMEOUT_MS },
        'graceful shutdown timed out; forcing exit',
      );
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await service.stop();
      await tracing?.shutdown();
      process.exitCode = exitCode;
    } catch (error) {
      logger.error({ error }, 'error during shutdown');
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.once('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('unhandledRejection', (error) => {
    logger.fatal({ error }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });

  try {
    await service.start();
  } catch (error) {
    logger.fatal({ error }, 'service failed to start');
    await service.stop().catch(() => undefined);
    process.exitCode = 1;
  }
}
