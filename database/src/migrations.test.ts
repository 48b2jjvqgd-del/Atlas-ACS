import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { permissionKeys, syntheticEmailDomainPattern, systemRoles } from '@atlas/contracts';
import {
  databaseRoot,
  discoverMigrationOwners,
  migrationFilePattern,
  seedsRoot,
} from './owners.js';
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
    for (const owner of readdirSync(join(seedsRoot, 'development'))) {
      const directory = join(seedsRoot, 'development', owner);
      for (const file of readdirSync(directory)) {
        const sql = readFileSync(join(directory, file), 'utf8');
        expect(sql).toContain('SYNTHETIC DATA ONLY');
        expect(sql).toMatch(/is_synthetic/);
      }
    }
  });

  it('uses only reserved .test addresses and no real-looking card data in seeds', () => {
    for (const owner of readdirSync(join(seedsRoot, 'development'))) {
      for (const file of readdirSync(join(seedsRoot, 'development', owner))) {
        const sql = readFileSync(join(seedsRoot, 'development', owner, file), 'utf8');
        for (const [, domain] of sql.matchAll(/@([a-z0-9.-]+)/g)) expect(domain).toMatch(/\.test$/);
        expect(sql).not.toMatch(/\b\d{13,19}\b/);
      }
    }
  });
});

describe('identity catalogue consistency', () => {
  const migration = readFileSync(
    join(databaseRoot, 'migrations', 'identity', '20261109090000_identity-foundations.sql'),
    'utf8',
  );

  it('seeds exactly the system roles of the permission catalogue, with matching scopes', () => {
    const seeded = [
      ...migration.matchAll(/\('([a-z-]+)',\s+'(platform|tenant)',\s+'[^']+',\s+true\)/g),
    ].map(([, key, scope]) => [key, scope]);
    expect(Object.fromEntries(seeded)).toEqual(
      Object.fromEntries(Object.entries(systemRoles).map(([key, role]) => [key, role.scope])),
    );
  });

  it('links every seeded identity to a user in the local Keycloak realm', () => {
    const realm = JSON.parse(
      readFileSync(
        join(databaseRoot, '..', 'infrastructure', 'docker', 'keycloak', 'atlas-realm.json'),
        'utf8',
      ),
    ) as { users: { id?: string; email?: string }[] };
    const realmUsers = new Map(realm.users.filter((u) => u.id).map((u) => [u.id, u.email]));
    const seed = readFileSync(
      join(seedsRoot, 'development', 'identity', '001_synthetic-users.sql'),
      'utf8',
    );
    const rows = [...seed.matchAll(/\('7c[0-9a-f-]+', '(5ab[0-9a-f-]+)', '([^']+)'/g)];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const [, subject, email] of rows) expect(realmUsers.get(subject)).toBe(email);
  });

  it('never commits a secret in the realm file: every credential is a placeholder', () => {
    const raw = readFileSync(
      join(databaseRoot, '..', 'infrastructure', 'docker', 'keycloak', 'atlas-realm.json'),
      'utf8',
    );
    for (const [, value] of raw.matchAll(/"(?:secret|value)":\s*"([^"]*)"/g))
      expect(value).toMatch(/^\$\{[A-Z0-9_:./-]+\}$/);
  });
});

describe('Stage 1A security remediation invariants', () => {
  const read = (schema: string, file: string) =>
    readFileSync(join(databaseRoot, 'migrations', schema, file), 'utf8');

  it('uses the contracts synthetic email pattern verbatim in the database constraints', () => {
    for (const schema of ['issuer', 'identity']) {
      expect(read(schema, '20261113091000_stage-1a-synthetic-only.sql')).toContain(
        `~ '${syntheticEmailDomainPattern}'`,
      );
    }
  });

  it('accepts every contracts permission key in the database catalogue', () => {
    const sql = read('identity', '20261113092000_permission-scope-enforcement.sql');
    const format = /permission_key_format CHECK \(key ~ '([^']+)'\)/.exec(sql)?.[1];
    expect(format).toBeDefined();
    for (const key of permissionKeys) expect(key).toMatch(new RegExp(format!));
  });

  it('leaves no row-level-security policy reading a session setting', () => {
    for (const schema of ['issuer', 'identity', 'audit']) {
      const sql = read(schema, '20261113090000_tenant-context-hardening.sql');
      const up = sql.slice(0, sql.indexOf('-- Down Migration'));
      expect(up).toContain(`DROP FUNCTION ${schema}.rls_tenant_visible(uuid);`);
      expect(up).not.toMatch(/current_setting\(/);
      expect(up).toMatch(/SECURITY DEFINER SET search_path = pg_catalog, pg_temp/);
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
