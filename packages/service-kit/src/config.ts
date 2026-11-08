import { serviceCatalog, type ServiceName } from '@atlas/contracts';
import {
  booleanStringSchema,
  logLevelSchema,
  portSchema,
  positiveIntSchema,
  urlWithProtocols,
  z,
} from '@atlas/schemas';
import { resolveSecrets } from '@atlas/security';
import { atlasEnvironments, ConfigurationError } from '@atlas/shared';

export type InfrastructureDependency = 'postgres' | 'valkey' | 'rabbitmq';

/** Environment variables that may carry credentials. Each also accepts a NAME_FILE variant. */
export const secretEnvironmentKeys = ['DATABASE_URL', 'VALKEY_URL', 'RABBITMQ_URL'] as const;

const dependencyUrlKeys: Record<InfrastructureDependency, (typeof secretEnvironmentKeys)[number]> =
  {
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
  };
}

export type BaseConfig = z.infer<z.ZodObject<ReturnType<typeof baseConfigShape>>> & {
  DATABASE_URL?: string;
  VALKEY_URL?: string;
  RABBITMQ_URL?: string;
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
): BaseConfig & z.infer<z.ZodObject<TShape>> {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

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
