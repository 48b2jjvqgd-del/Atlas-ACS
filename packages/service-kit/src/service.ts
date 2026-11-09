import type { ServiceName } from '@atlas/contracts';
import type { Logger, ServiceMetrics } from '@atlas/observability';
import type { z } from '@atlas/schemas';
import type { FastifyInstance } from 'fastify';
import type { AccessDeniedEvent, PrincipalResolver } from './auth/access.js';
import type { ServiceTokenProvider } from './auth/service-tokens.js';
import type { TokenVerifier } from './auth/tokens.js';
import type { BaseConfig, InfrastructureDependency } from './config.js';
import type { ServiceClient } from './http-client.js';
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

export interface ServiceSecurity {
  verifier: TokenVerifier;
  /** Service-token provider for outbound calls (when the service declares calls). */
  tokens?: ServiceTokenProvider;
}

export interface ServiceContext<TConfig extends BaseConfig = BaseConfig> {
  config: TConfig;
  logger: Logger;
  metadata: ServiceMetadata;
  infrastructure: Infrastructure;
  readiness: ReadinessRegistry;
  metrics: ServiceMetrics;
  /** Authenticated clients for the services this service declared it calls. */
  clients: Partial<Record<ServiceName, ServiceClient>>;
  security?: ServiceSecurity;
  /** Hooks run on shutdown after the HTTP server has drained (before connections close). */
  onShutdown(hook: () => Promise<void>): void;
}

/** Security declaration for a service (Stage 1A). */
export interface ServiceSecurityDefinition<TShape extends z.ZodRawShape> {
  /** Authenticate callers on application routes (installs deny-by-default access control). */
  verifyTokens?: boolean;
  /** Services this service calls; each gets an authenticated client in context.clients. */
  calls?: readonly ServiceName[];
  /**
   * How principals are resolved. Default: ask identity-service (which must then be in `calls`).
   * identity-service itself resolves from its own database.
   */
  principals?: (context: ServiceContext<ServiceConfig<TShape>>) => PrincipalResolver;
  /** Records access-denied events (normally to the audit trail). */
  onDenied?: (
    context: ServiceContext<ServiceConfig<TShape>>,
  ) => (event: AccessDeniedEvent) => Promise<void>;
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
  security?: ServiceSecurityDefinition<TShape>;
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
