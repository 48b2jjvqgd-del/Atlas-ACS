import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { serviceCatalog, type ServiceName } from '@atlas/contracts';

/**
 * Migration ownership.
 *
 * Migrations live in database/migrations/<schema>/, where <schema> is the PostgreSQL schema
 * owned by exactly one service (see the service catalogue). Each owner has its own migration
 * history table (<schema>.pgmigrations), so one service's migrations can be applied, rolled
 * back or later moved to a separate database without touching any other service.
 */
export const databaseRoot = join(import.meta.dirname, '..');
export const migrationsRoot = join(databaseRoot, 'migrations');
export const seedsRoot = join(databaseRoot, 'seeds');

export interface MigrationOwner {
  schema: string;
  service: ServiceName;
  directory: string;
}

export function schemaOwners(): Map<string, ServiceName> {
  const owners = new Map<string, ServiceName>();
  for (const [service, entry] of Object.entries(serviceCatalog) as [
    ServiceName,
    (typeof serviceCatalog)[ServiceName],
  ][]) {
    if (entry.dataStores.postgresSchema) owners.set(entry.dataStores.postgresSchema, service);
  }
  return owners;
}

/** Owners that currently have migrations, in a stable order. */
export function discoverMigrationOwners(root = migrationsRoot): MigrationOwner[] {
  if (!existsSync(root)) return [];
  const owners = schemaOwners();
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const service = owners.get(entry.name);
      if (!service) {
        throw new Error(
          `migrations/${entry.name} does not correspond to a schema in the service catalogue`,
        );
      }
      return { schema: entry.name, service, directory: join(root, entry.name) };
    })
    .sort((a, b) => a.schema.localeCompare(b.schema));
}

export const migrationFilePattern = /^\d{14}_[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/;
