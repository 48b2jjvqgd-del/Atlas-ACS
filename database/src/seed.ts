import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowsSyntheticData, type AtlasEnvironment } from '@atlas/shared';
import pg from 'pg';
import { schemaOwners, seedsRoot } from './owners.js';

/**
 * Development seed data.
 *
 * - Seeds contain synthetic data only, and every seeded row is flagged is_synthetic = true.
 * - Seeds run only in development, test or simulation environments; any other ATLAS_ENV is
 *   refused before a connection is opened.
 * - Seeds are idempotent (ON CONFLICT DO NOTHING) and run per owner in a transaction.
 * - Seeds never create schema: they require the owner's migrations to have been applied.
 */
export async function runSeeds(options: {
  databaseUrl: string;
  environment: AtlasEnvironment;
  root?: string;
  log?: (message: string) => void;
}): Promise<string[]> {
  if (!allowsSyntheticData(options.environment)) {
    throw new Error(
      `Refusing to seed: ATLAS_ENV "${options.environment}" does not permit synthetic data`,
    );
  }
  const root = join(options.root ?? seedsRoot, 'development');
  if (!existsSync(root)) return [];
  const owners = schemaOwners();
  const log = options.log ?? (() => undefined);
  const applied: string[] = [];

  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    for (const schema of readdirSync(root).sort()) {
      if (!owners.has(schema)) throw new Error(`seeds/development/${schema} has no owning service`);
      const files = readdirSync(join(root, schema))
        .filter((file) => file.endsWith('.sql'))
        .sort();
      await client.query('BEGIN');
      try {
        for (const file of files) {
          await client.query(readFileSync(join(root, schema, file), 'utf8'));
          applied.push(`${schema}/${file}`);
          log(`seeded ${schema}/${file}`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
