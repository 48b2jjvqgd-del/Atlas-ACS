import type { ServiceName } from '@atlas/contracts';
import { atlasEnvironments, type AtlasEnvironment } from '@atlas/shared';
import { resolveSecret } from '@atlas/security';
import { serviceRoles, servicePasswordVariable } from '../roles.js';

/**
 * Database tooling connections. All support the *_FILE secret convention.
 *
 *   DATABASE_ADMIN_URL      administrative role (superuser or CREATEROLE): role provisioning only
 *   MIGRATION_DATABASE_URL  atlas_migrator: migrations, grants and seeds
 *
 * Runtime services never receive either; each has its own least-privilege role (roles.ts).
 */
export function migrationDatabaseUrl(env = process.env): string {
  const url = resolveSecret(env, 'MIGRATION_DATABASE_URL');
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL (see .env.example)');
  return url;
}

export function adminDatabaseUrl(env = process.env): string {
  const url = resolveSecret(env, 'DATABASE_ADMIN_URL');
  if (!url)
    throw new Error('Set DATABASE_ADMIN_URL to provision database roles (see .env.example)');
  return url;
}

export function rolePasswords(env = process.env): {
  migratorPassword: string;
  servicePasswords: Partial<Record<ServiceName, string>>;
} {
  const migratorPassword = resolveSecret(env, 'DB_PASSWORD_MIGRATOR');
  if (!migratorPassword) throw new Error('Set DB_PASSWORD_MIGRATOR (see .env.example)');
  const servicePasswords: Partial<Record<ServiceName, string>> = {};
  const missing: string[] = [];
  for (const { service } of serviceRoles()) {
    const variable = servicePasswordVariable(service);
    const value = resolveSecret(env, variable);
    if (value) servicePasswords[service] = value;
    else missing.push(variable);
  }
  if (missing.length > 0) throw new Error(`Set ${missing.join(', ')} (see .env.example)`);
  return { migratorPassword, servicePasswords };
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
