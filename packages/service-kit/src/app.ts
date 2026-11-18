import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  headers,
  type LivenessResponse,
  type ReadinessResponse,
  type ServiceInfo,
} from '@atlas/contracts';
import { annotateActiveSpan, type Logger, type ServiceMetrics } from '@atlas/observability';
import { correlationIdSchema } from '@atlas/schemas';
import {
  apiHelmetOptions,
  DEFAULT_BODY_LIMIT_BYTES,
  DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from '@atlas/security';
import helmet from '@fastify/helmet';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { BaseConfig } from './config.js';
import { sendProblem, toProblem } from './errors.js';
import type { ReadinessRegistry } from './health.js';
import type { ServiceMetadata } from './service.js';
import { installZodCompilers } from './zod-compiler.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Correlation ID for this request: propagated from upstream when valid, else generated. */
    correlationId: string;
  }
}

const correlationSymbol = Symbol('atlas.correlationId');
type RawWithCorrelation = IncomingMessage & { [correlationSymbol]?: string };

/** Accepts an upstream correlation ID only if it is well-formed; otherwise starts a new one. */
export function resolveCorrelationId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && correlationIdSchema.safeParse(candidate).success ? candidate : randomUUID();
}

const infrastructureRoute = /^\/(health|metrics|info)(\/|$)/;

export interface BuildAppOptions {
  config: BaseConfig;
  logger: Logger;
  metadata: ServiceMetadata;
  readiness: ReadinessRegistry;
  metrics: ServiceMetrics;
}

/**
 * Builds the Fastify instance with every ATLAS cross-cutting convention applied:
 * secure headers, body limits, correlation IDs, structured request logging, metrics,
 * standard error responses and the infrastructure endpoints.
 */
export async function buildServiceApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, logger, metadata, readiness, metrics } = options;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // Request IDs identify a single hop and are always generated locally; never trust a client's.
    genReqId: () => randomUUID(),
    childLoggerFactory: (parent, bindings, childOptions, rawRequest) => {
      const raw = rawRequest as RawWithCorrelation;
      raw[correlationSymbol] = resolveCorrelationId(raw.headers[headers.correlationId]);
      return parent.child({ ...bindings, correlationId: raw[correlationSymbol] }, childOptions);
    },
    // Fastify's per-request logs are replaced by the single 'request completed' line below.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'reqId' }),
    bodyLimit: DEFAULT_BODY_LIMIT_BYTES,
    requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    return503OnClosing: true,
    trustProxy: config.TRUSTED_PROXY_ADDRESSES?.length ? config.TRUSTED_PROXY_ADDRESSES : false,
  });

  installZodCompilers(app);
  await app.register(helmet, apiHelmetOptions);

  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (request, reply) => {
    request.correlationId =
      (request.raw as RawWithCorrelation)[correlationSymbol] ?? resolveCorrelationId(undefined);
    reply.header(headers.correlationId, request.correlationId);
    reply.header(headers.requestId, request.id);
    annotateActiveSpan({ 'atlas.correlation_id': request.correlationId });
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const durationSeconds = reply.elapsedTime / 1000;
    metrics.httpRequestDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      durationSeconds,
    );
    const entry = {
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100,
    };
    if (infrastructureRoute.test(route)) request.log.debug(entry, 'request completed');
    else request.log.info(entry, 'request completed');
  });

  app.setErrorHandler((error, request, reply) => {
    const problem = toProblem(error, request);
    if (problem.status >= 500) {
      request.log.error({ error }, 'request failed');
    } else {
      request.log.info({ code: problem.code, status: problem.status }, 'request rejected');
    }
    return sendProblem(reply, problem);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      toProblem(Object.assign(new Error('Not found'), { statusCode: 404 }), request),
    ),
  );

  // ---- Infrastructure endpoints (unversioned, stable paths) ----

  app.get('/health/live', async (): Promise<LivenessResponse> => ({
    status: 'ok',
    service: metadata.name,
  }));

  app.get('/health/ready', async (_request, reply): Promise<ReadinessResponse> => {
    const result = await readiness.run(config.READINESS_CHECK_TIMEOUT_MS);
    reply.status(result.ready ? 200 : 503);
    return {
      status: result.ready ? 'ready' : 'not_ready',
      service: metadata.name,
      checks: result.checks,
    };
  });

  app.get('/info', async (): Promise<ServiceInfo> => ({
    service: metadata.name,
    version: metadata.version,
    environment: config.ATLAS_ENV,
    apiVersions: [...metadata.apiVersions],
    build: { sha: config.ATLAS_BUILD_SHA ?? null },
    startedAt: metadata.startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - metadata.startedAt.getTime()) / 1000),
  }));

  app.get('/metrics', async (_request, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  return app;
}
