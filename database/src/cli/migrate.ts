/**
 * Usage:
 *   migrate up     [--owner <schema>] [--count <n>]
 *   migrate down    --owner <schema>  [--count <n>]   (default count 1)
 *   migrate status
 */
import { migrate, migrationStatus } from '../migrate.js';
import { atlasEnvironment, flag, migrationDatabaseUrl } from './env.js';

const [command = 'status', ...args] = process.argv.slice(2);

try {
  const databaseUrl = migrationDatabaseUrl();
  const environment = atlasEnvironment();
  const owner = flag(args, 'owner');
  const countValue = flag(args, 'count');
  const count = countValue === undefined ? undefined : Number.parseInt(countValue, 10);
  if (count !== undefined && (!Number.isInteger(count) || count < 1))
    throw new Error('--count must be a positive integer');

  if (command === 'up' || command === 'down') {
    if (
      command === 'down' &&
      environment === 'production' &&
      !args.includes('--allow-production-rollback')
    ) {
      throw new Error(
        'Rollback in production requires --allow-production-rollback and an approved change',
      );
    }
    const results = await migrate({
      databaseUrl,
      direction: command,
      ...(owner ? { owner } : {}),
      ...(count ? { count } : {}),
    });
    for (const [schema, ran] of Object.entries(results)) {
      console.log(
        `${schema}: ${ran.length === 0 ? 'nothing to do' : `${command} ${ran.map((m) => m.name).join(', ')}`}`,
      );
    }
  } else if (command === 'status') {
    for (const status of await migrationStatus(databaseUrl)) {
      console.log(
        `${status.schema} (owner: ${status.service}) applied=${status.applied.length} pending=${status.pending.length}`,
      );
      for (const name of status.pending) console.log(`  pending  ${name}`);
    }
  } else {
    throw new Error(`Unknown command "${command}". Use up, down or status.`);
  }
} catch (error) {
  console.error(`migrate: ${(error as Error).message}`);
  process.exitCode = 1;
}
