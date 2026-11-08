import { atlasEnvironments, type AtlasEnvironment } from '@atlas/shared';
import { resolveSecret } from '@atlas/security';

/**
 * Migrations should run with a privileged migration role (MIGRATION_DATABASE_URL) distinct from
 * the runtime roles services use. Locally a single role is acceptable, so DATABASE_URL is the
 * fallback. Both support the *_FILE secret convention.
 */
export function migrationDatabaseUrl(env = process.env): string {
  const url = resolveSecret(env, 'MIGRATION_DATABASE_URL') ?? resolveSecret(env, 'DATABASE_URL');
  if (!url) {
    throw new Error('Set MIGRATION_DATABASE_URL or DATABASE_URL (see .env.example)');
  }
  return url;
}

export function atlasEnvironment(env = process.env): AtlasEnvironment {
  const value = env.ATLAS_ENV ?? 'development';
  if (!(atlasEnvironments as readonly string[]).includes(value)) {
    throw new Error(`ATLAS_ENV must be one of: ${atlasEnvironments.join(', ')}`);
  }
  return value as AtlasEnvironment;
}

export function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}
