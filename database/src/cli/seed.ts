import { runSeeds } from '../seed.js';
import { atlasEnvironment, migrationDatabaseUrl } from './env.js';

try {
  const applied = await runSeeds({
    databaseUrl: migrationDatabaseUrl(),
    environment: atlasEnvironment(),
    log: (message) => console.log(message),
  });
  console.log(
    applied.length ? `Seeded ${applied.length} file(s) of synthetic data.` : 'No seed files found.',
  );
} catch (error) {
  console.error(`seed: ${(error as Error).message}`);
  process.exitCode = 1;
}
