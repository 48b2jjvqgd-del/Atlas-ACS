import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMigrationOwners, migrationFilePattern, seedsRoot } from './owners.js';
import { migrate } from './migrate.js';
import { runSeeds } from './seed.js';

describe('migration conventions', () => {
  const owners = discoverMigrationOwners();

  it('maps every migration directory to a schema owned by exactly one service', () => {
    expect(owners.map((owner) => owner.schema)).toContain('issuer');
    expect(owners.find((owner) => owner.schema === 'issuer')?.service).toBe('issuer-service');
  });

  for (const owner of owners) {
    const files = readdirSync(owner.directory).filter((file) => file.endsWith('.sql'));

    it(`${owner.schema}: names migrations <14-digit timestamp>_<kebab-name>.sql`, () => {
      for (const file of files) expect(file).toMatch(migrationFilePattern);
    });

    it(`${owner.schema}: every migration has a Down section (rollback strategy)`, () => {
      for (const file of files) {
        const sql = readFileSync(join(owner.directory, file), 'utf8');
        expect(sql).toMatch(/^-- Up Migration$/m);
        expect(sql).toMatch(/^-- Down Migration$/m);
      }
    });

    it(`${owner.schema}: never writes to another owner's schema`, () => {
      const others = owners
        .filter((other) => other.schema !== owner.schema)
        .map((other) => other.schema);
      for (const file of files) {
        const sql = readFileSync(join(owner.directory, file), 'utf8');
        for (const other of others) expect(sql).not.toMatch(new RegExp(`\\b${other}\\.`, 'i'));
      }
    });
  }

  it('flags every seeded row as synthetic', () => {
    const directory = join(seedsRoot, 'development', 'issuer');
    for (const file of readdirSync(directory)) {
      const sql = readFileSync(join(directory, file), 'utf8');
      expect(sql).toContain('SYNTHETIC DATA ONLY');
      expect(sql).toMatch(/is_synthetic/);
    }
  });
});

describe('safety guards (no database required)', () => {
  it('refuses to roll back without an explicit owner', async () => {
    await expect(
      migrate({ databaseUrl: 'postgres://x@127.0.0.1:1/x', direction: 'down' }),
    ).rejects.toThrow(/explicit owner/);
  });

  it('refuses to seed outside synthetic-data environments before connecting', async () => {
    await expect(
      runSeeds({ databaseUrl: 'postgres://x@127.0.0.1:1/x', environment: 'production' }),
    ).rejects.toThrow(/Refusing to seed/);
  });
});
