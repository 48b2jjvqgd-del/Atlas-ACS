import type { ServiceName } from '@atlas/contracts';
import type { Logger } from '@atlas/observability';
import type { z } from '@atlas/schemas';
import type { FastifyInstance } from 'fastify';
import type { BaseConfig, InfrastructureDependency } from './config.js';
import type { PostgresConnector } from './connectors/postgres.js';
import type { RabbitMqConnector } from './connectors/rabbitmq.js';
import type { ValkeyConnector } from './connectors/valkey.js';
import type { ReadinessRegistry } from './health.js';

export interface ServiceMetadata {
  name: ServiceName;
  version: string;
  apiVersions: readonly string[];
  startedAt: Date;
}

export interface Infrastructure {
  postgres?: PostgresConnector;
  valkey?: ValkeyConnector;
  rabbitmq?: RabbitMqConnector;
}

export interface ServiceContext<TConfig extends BaseConfig = BaseConfig> {
  config: TConfig;
  logger: Logger;
  metadata: ServiceMetadata;
  infrastructure: Infrastructure;
  readiness: ReadinessRegistry;
}

export type ServiceConfig<TShape extends z.ZodRawShape> = BaseConfig & z.infer<z.ZodObject<TShape>>;

/**
 * Declarative description of a service. Everything a service needs to be started, probed,
 * configured and shut down derives from this; the service's own code lives in `register`.
 */
export interface ServiceDefinition<TShape extends z.ZodRawShape = z.ZodRawShape> {
  name: ServiceName;
  version: string;
  /** Infrastructure the service owns or depends on. Drives config validation and readiness. */
  dependencies: readonly InfrastructureDependency[];
  /** Additional, service-specific environment configuration. */
  configShape?: TShape;
  /** API major versions this service serves. */
  apiVersions?: readonly string[];
  /** Registers the service's own routes, hooks and readiness checks. */
  register?: (
    app: FastifyInstance,
    context: ServiceContext<ServiceConfig<TShape>>,
  ) => void | Promise<void>;
}

export function defineService<TShape extends z.ZodRawShape = Record<never, never>>(
  definition: ServiceDefinition<TShape>,
): ServiceDefinition<TShape> {
  return definition;
}
