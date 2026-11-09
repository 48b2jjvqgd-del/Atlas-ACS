import { serviceCatalog, type ServiceName } from '@atlas/contracts';
import {
  booleanStringSchema,
  commaListSchema,
  logLevelSchema,
  portSchema,
  positiveIntSchema,
  urlWithProtocols,
  z,
} from '@atlas/schemas';
import { resolveSecrets } from '@atlas/security';
import { atlasEnvironments, ConfigurationError } from '@atlas/shared';

import { resolveServiceUrls } from './service-urls.js';

export type InfrastructureDependency = 'postgres' | 'valkey' | 'rabbitmq';

/** Environment variables that may carry credentials. Each also accepts a NAME_FILE variant. */
export const secretEnvironmentKeys = [
  'DATABASE_URL',
  'VALKEY_URL',
  'RABBITMQ_URL',
  'SERVICE_CLIENT_SECRET',
  'OIDC_CLIENT_SECRET',
  'SESSION_ENCRYPTION_KEY',
] as const;

/**
 * Security needs a service declares (Stage 1A). They drive which settings are required:
 *  - verifyTokens: the service authenticates callers → OIDC_ISSUER_URL is required.
 *  - calls: services it calls → OIDC_ISSUER_URL and SERVICE_CLIENT_SECRET are required.
 */
export interface SecurityRequirements {
  verifyTokens?: boolean;
  calls?: readonly ServiceName[];
}

/**
 * A service-specific connection URL, e.g. ISSUER_SERVICE_DATABASE_URL, takes precedence over
 * DATABASE_URL. This lets one .env serve every service on a developer machine while each service
 * still connects with its own least-privilege database role.
 */
export function serviceEnvironmentPrefix(service: ServiceName): string {
  return service.replaceAll('-', '_').toUpperCase();
}

const dependencyUrlKeys: Record<
  InfrastructureDependency,
  'DATABASE_URL' | 'VALKEY_URL' | 'RABBITMQ_URL'
> = {
  postgres: 'DATABASE_URL',
  valkey: 'VALKEY_URL',
  rabbitmq: 'RABBITMQ_URL',
};

const dependencyUrlSchemas = {
  DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:']),
  VALKEY_URL: urlWithProtocols(['redis:', 'rediss:']),
  RABBITMQ_URL: urlWithProtocols(['amqp:', 'amqps:']),
};

/** Configuration every ATLAS service understands. Service-specific keys extend this. */
export function baseConfigShape(defaultPort: number) {
  return {
    ATLAS_ENV: z.enum(atlasEnvironments).default('development'),
    /** Loopback by default so a developer machine never exposes services unintentionally. */
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: portSchema.default(defaultPort),
    LOG_LEVEL: logLevelSchema.default('info'),
    LOG_PRETTY: booleanStringSchema.default(false),
    SHUTDOWN_TIMEOUT_MS: positiveIntSchema.default(10_000),
    READINESS_CHECK_TIMEOUT_MS: positiveIntSchema.default(2_000),
    ATLAS_BUILD_SHA: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    /** Service address book ("name=url,..."); defaults to local ports. */
    ATLAS_SERVICE_URLS: z
      .string()
      .optional()
      .transform((value, context) => {
        try {
          return resolveServiceUrls(value);
        } catch (error) {
          context.addIssue({ code: 'custom', message: (error as Error).message });
          return z.NEVER;
        }
      }),
    /** Public issuer URL of the OIDC provider: the expected "iss" claim. */
    OIDC_ISSUER_URL: z.url().optional(),
    /** Back-channel base URL of the same issuer (e.g. inside Docker); defaults to OIDC_ISSUER_URL. */
    OIDC_INTERNAL_URL: z.url().optional(),
    /** Platform-wide permissions require a second factor at sign-in. */
    PLATFORM_MFA_REQUIRED: booleanStringSchema.default(true),
    SERVICE_CALL_TIMEOUT_MS: positiveIntSchema.default(3_000),
    /**
     * Reverse proxies (addresses or CIDRs) whose X-Forwarded-For is trusted, e.g. the portal's
     * nginx. Unset: the TCP peer is the client (Stage 0 behaviour).
     */
    TRUSTED_PROXY_ADDRESSES: commaListSchema.optional(),
  };
}

export type BaseConfig = z.infer<z.ZodObject<ReturnType<typeof baseConfigShape>>> & {
  DATABASE_URL?: string;
  VALKEY_URL?: string;
  RABBITMQ_URL?: string;
  SERVICE_CLIENT_SECRET?: string;
};

/**
 * Loads and validates configuration from environment variables.
 *
 * - Empty strings are treated as unset (common with .env files and CI variables).
 * - Secrets are resolved from NAME_FILE when supplied.
 * - Connection URLs are required exactly when the service declares that dependency.
 * - On failure, throws ConfigurationError naming the offending keys. Values are never included,
 *   because a mistyped value may still be a secret.
 */
export function loadServiceConfig<TShape extends z.ZodRawShape>(
  service: ServiceName,
  dependencies: readonly InfrastructureDependency[],
  extraShape: TShape,
  env: Readonly<Record<string, string | undefined>>,
  security: SecurityRequirements = {},
): BaseConfig & z.infer<z.ZodObject<TShape>> {
  const cleaned: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '',
    ),
  );
  const prefix = serviceEnvironmentPrefix(service);
  for (const key of ['DATABASE_URL', 'SERVICE_CLIENT_SECRET'] as const) {
    for (const suffix of ['', '_FILE']) {
      const specific = cleaned[`${prefix}_${key}${suffix}`];
      if (specific !== undefined) {
        delete cleaned[`${key}`];
        delete cleaned[`${key}_FILE`];
        cleaned[`${key}${suffix}`] = specific;
      }
    }
  }

  let resolved: Record<string, string | undefined>;
  try {
    resolved = resolveSecrets(cleaned, secretEnvironmentKeys);
  } catch (error) {
    const key =
      secretEnvironmentKeys.find((name) => (error as Error).message.includes(name)) ?? 'SECRET';
    throw new ConfigurationError([{ key, message: (error as Error).message }]);
  }

  const dependencyShape: Record<string, z.ZodType> = {};
  for (const dependency of dependencies) {
    const key = dependencyUrlKeys[dependency];
    dependencyShape[key] = dependencyUrlSchemas[key];
  }

  const callsServices = (security.calls?.length ?? 0) > 0;
  if (security.verifyTokens || callsServices) dependencyShape.OIDC_ISSUER_URL = z.url();
  if (callsServices) dependencyShape.SERVICE_CLIENT_SECRET = z.string().min(16);

  const schema = z.object({
    ...baseConfigShape(serviceCatalog[service].port),
    ...dependencyShape,
    ...extraShape,
  });

  const result = schema.safeParse(resolved);
  if (!result.success) {
    throw new ConfigurationError(
      result.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        message: describeIssue(issue),
      })),
    );
  }
  return result.data as BaseConfig & z.infer<z.ZodObject<TShape>>;
}

/** Produces a value-free description of a validation issue. */
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined ? 'is required' : `must be a valid ${issue.expected}`;
    case 'invalid_value':
      return `must be one of: ${issue.values.map(String).join(', ')}`;
    case 'too_small':
    case 'too_big':
      return 'is out of range';
    case 'invalid_format':
      return `must be a valid ${issue.format}`;
    default:
      return issue.message.startsWith('URL must use') ? issue.message : 'is invalid';
  }
}
