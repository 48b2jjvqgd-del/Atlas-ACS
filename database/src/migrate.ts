import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { discoverMigrationOwners, type MigrationOwner } from './owners.js';

export const MIGRATIONS_TABLE = 'pgmigrations';

type RunMigration = Awaited<ReturnType<typeof runner>>[number];

export interface MigrateOptions {
  databaseUrl: string;
  direction: 'up' | 'down';
  /** Restrict to one owner schema. Required for "down". */
  owner?: string;
  /** Number of migrations to apply/revert. Default: all for up, 1 for down. */
  count?: number;
  log?: (message: string) => void;
}

function selectOwners(owner: string | undefined): MigrationOwner[] {
  const owners = discoverMigrationOwners();
  if (!owner) return owners;
  const selected = owners.filter((candidate) => candidate.schema === owner);
  if (selected.length === 0) throw new Error(`No migrations found for owner "${owner}"`);
  return selected;
}

/**
 * Applies or reverts migrations for each owner in turn, each owner in its own schema with its
 * own history table. Each run executes in a single transaction, so a failing migration leaves
 * that owner's schema unchanged.
 */
export async function migrate(options: MigrateOptions): Promise<Record<string, RunMigration[]>> {
  if (options.direction === 'down' && !options.owner) {
    throw new Error(
      'Rolling back requires an explicit owner; refusing to roll back every service at once',
    );
  }
  const results: Record<string, RunMigration[]> = {};
  for (const owner of selectOwners(options.owner)) {
    results[owner.schema] = await runner({
      databaseUrl: options.databaseUrl,
      dir: owner.directory,
      direction: options.direction,
      count: options.count ?? (options.direction === 'down' ? 1 : Infinity),
      schema: owner.schema,
      createSchema: true,
      migrationsSchema: owner.schema,
      createMigrationsSchema: true,
      migrationsTable: MIGRATIONS_TABLE,
      checkOrder: true,
      singleTransaction: true,
      ignorePattern: '(\\..*|.*\\.md)',
      log: options.log ?? (() => undefined),
      verbose: false,
    });
  }
  return results;
}

export interface OwnerStatus {
  schema: string;
  service: string;
  applied: string[];
  pending: string[];
}

/** Reports applied and pending migrations per owner without changing anything. */
export async function migrationStatus(databaseUrl: string): Promise<OwnerStatus[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const statuses: OwnerStatus[] = [];
    for (const owner of discoverMigrationOwners()) {
      const files = readdirSync(owner.directory)
        .filter((file) => file.endsWith('.sql'))
        .map((file) => file.replace(/\.sql$/, ''))
        .sort();
      const exists = await client.query<{ present: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS present',
        [`${owner.schema}.${MIGRATIONS_TABLE}`],
      );
      const applied = exists.rows[0]?.present
        ? (
            await client.query<{ name: string }>(
              `SELECT name FROM ${pg.escapeIdentifier(owner.schema)}.${MIGRATIONS_TABLE} ORDER BY run_on, id`,
            )
          ).rows.map((row) => row.name)
        : [];
      statuses.push({
        schema: owner.schema,
        service: owner.service,
        applied,
        pending: files.filter((file) => !applied.includes(file)),
      });
    }
    return statuses;
  } finally {
    await client.end();
  }
}
