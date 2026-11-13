import { randomUUID } from 'node:crypto';
import {
  applyServiceGrants,
  serviceRoles,
  synchroniseAuthorisationCatalogue,
} from '@atlas/database';
import { createLogger } from '@atlas/observability';
import { createPostgresConnector, inScope, type PostgresConnector } from '@atlas/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  scoped,
  servicePasswords,
  withClient,
  type TestDatabase,
} from './database.js';

/**
 * ADR-012 credentials gate, tenant isolation, permission scopes and the synthetic-data rule, all
 * enforced by the database itself and exercised *directly* with each service's own credentials —
 * i.e. as SQL injection or a code path that bypasses the service's application checks would.
 */
let db: TestDatabase;
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER = randomUUID();

beforeAll(async () => {
  db = await createTestDatabase('sec');
  await withClient(db.migratorUrl, async (client) => {
    await client.query(
      `INSERT INTO issuer.tenant (id, slug, display_name, internal_reference, status, is_synthetic)
       VALUES ($1, 'tenant-a', 'Tenant A', 'TA-1', 'active', true), ($2, 'tenant-b', 'Tenant B', 'TB-1', 'active', true)`,
      [TENANT_A, TENANT_B],
    );
    await client.query(
      `INSERT INTO audit.audit_record (id, chain, occurred_at, actor_type, actor_id, tenant_id, action, resource_type, resource_id, outcome, correlation_id, source_service, hash)
       VALUES ($1, $2::text, now(), 'system', 'test', $2::uuid, 'test.recorded', 'test', 'x', 'success', 'corr-0001', 'test', $3),
              ($4, 'platform', now(), 'system', 'test', NULL, 'test.recorded', 'test', 'x', 'success', 'corr-0002', 'test', $3)`,
      [randomUUID(), TENANT_A, 'a'.repeat(64), randomUUID()],
    );
    await client.query(
      `INSERT INTO identity.user_account (id, email, display_name, status, is_synthetic)
       VALUES ($1, 'member@isolation.test', 'Member', 'active', true)`,
      [USER],
    );
    await client.query(
      `INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by)
       VALUES ($1, $2, 'reporting-user', 'test'), ($1, $3, 'reporting-user', 'test')`,
      [USER, TENANT_A, TENANT_B],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const asIssuerService = <T>(work: (client: pg.Client) => Promise<T>) =>
  withClient(db.roleUrl('issuer-service'), work);
const asIdentityService = <T>(work: (client: pg.Client) => Promise<T>) =>
  withClient(db.roleUrl('identity-service'), work);
const tenantIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

// ============================================================================ credentials

describe('per-service database credentials (ADR-012)', () => {
  it('lets each service role use its own schema only — tables and functions', async () => {
    const tables: Record<string, string> = {
      issuer: 'issuer.tenant',
      identity: 'identity.user_account',
      audit: 'audit.audit_record',
    };
    for (const { service, schema } of serviceRoles()) {
      await withClient(db.roleUrl(service), async (client) => {
        for (const [owner, table] of Object.entries(tables)) {
          const attempt = client.query(`SELECT count(*) FROM ${table}`);
          if (owner === schema)
            await expect(attempt, `${service} → own ${table}`).resolves.toBeDefined();
          else await expect(attempt, `${service} → ${table}`).rejects.toThrow(/permission denied/);
          if (owner !== schema) {
            // Another service's tenant-context function is out of reach as well.
            await expect(
              client.query(`SELECT ${owner}.begin_tenant_context('all', '{}')`),
              `${service} → ${owner}.begin_tenant_context`,
            ).rejects.toThrow(/permission denied/);
          }
        }
      });
    }
  });

  it('denies DDL, the public schema, temporary tables and migration history to service roles', async () => {
    await asIssuerService(async (client) => {
      await expect(client.query('CREATE TABLE issuer.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('CREATE TABLE public.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('CREATE TEMP TABLE sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DROP TABLE issuer.tenant')).rejects.toThrow(/must be owner/);
      await expect(client.query('SELECT * FROM issuer.pgmigrations')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        client.query('ALTER TABLE issuer.tenant DISABLE ROW LEVEL SECURITY'),
      ).rejects.toThrow(/must be owner/);
      await expect(client.query('ALTER TABLE issuer.tenant DISABLE TRIGGER ALL')).rejects.toThrow(
        /must be owner/,
      );
    });
  });

  it('gives service roles no elevated attributes', async () => {
    for (const { role } of serviceRoles()) {
      const attributes = await withClient(db.migratorUrl, (client) =>
        client.query<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          rolcreaterole: boolean;
          rolcreatedb: boolean;
        }>(
          'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1',
          [role],
        ),
      );
      expect(attributes.rows[0], role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      });
    }
  });

  it('cannot connect with another service’s password', async () => {
    const wrong = db.urlFor('atlas_issuer_service', servicePasswords['audit-service']!);
    await expect(withClient(wrong, (client) => client.query('SELECT 1'))).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it('re-applies grants idempotently', async () => {
    const applied = await withClient(db.migratorUrl, (client) => applyServiceGrants(client));
    expect(applied).toEqual(
      expect.arrayContaining([
        'issuer → atlas_issuer_service (read-write)',
        'audit → atlas_audit_service (append-only)',
      ]),
    );
  });
});

// ============================================================================ Finding 1: RLS context

describe('row-level security: tenant context held by the database (Finding 1)', () => {
  it('shows no tenant rows without a context', async () => {
    await asIssuerService(async (client) => {
      const rows = await scoped(client, 'issuer', null, [], () =>
        client.query('SELECT id FROM issuer.tenant'),
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it('limits a tenant context to its own tenants, even with no WHERE clause', async () => {
    await asIssuerService(async (client) => {
      const rows = await scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
        client.query<{ id: string }>('SELECT id FROM issuer.tenant'),
      );
      expect(tenantIds(rows.rows)).toEqual([TENANT_A]);
      const all = await scoped(client, 'issuer', 'all', [], () =>
        client.query('SELECT id FROM issuer.tenant'),
      );
      expect(all.rowCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('ignores the former session settings: set_config and SET LOCAL cannot widen a tenant context', async () => {
    await asIssuerService(async (client) => {
      const viaSetConfig = await scoped(client, 'issuer', 'tenant', [TENANT_A], async () => {
        await client.query(
          "SELECT set_config('atlas.scope', 'all', true), set_config('atlas.tenant_ids', $1, true)",
          [`{${TENANT_A},${TENANT_B}}`],
        );
        return client.query<{ id: string }>('SELECT id FROM issuer.tenant');
      });
      expect(tenantIds(viaSetConfig.rows)).toEqual([TENANT_A]);

      const viaSet = await scoped(client, 'issuer', 'tenant', [TENANT_A], async () => {
        await client.query("SET LOCAL atlas.scope = 'all'");
        return client.query<{ id: string }>('SELECT id FROM issuer.tenant');
      });
      expect(tenantIds(viaSet.rows)).toEqual([TENANT_A]);

      // Without any declared context the settings grant nothing either.
      const settingsOnly = await scoped(client, 'issuer', null, [], async () => {
        await client.query("SELECT set_config('atlas.scope', 'all', true)");
        return client.query('SELECT id FROM issuer.tenant');
      });
      expect(settingsOnly.rowCount).toBe(0);
    });
  });

  it('cannot be widened by an injected expression inside a single statement', async () => {
    await asIssuerService(async (client) => {
      // What SQL injection into a WHERE clause of a tenant-scoped query could attempt.
      const injected = await scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
        client.query<{ id: string }>(
          `SELECT id FROM issuer.tenant
            WHERE slug = 'x' OR set_config('atlas.scope', 'all', true) IS NOT NULL`,
        ),
      );
      expect(tenantIds(injected.rows)).toEqual([TENANT_A]);
    });
  });

  it('can be declared only once per transaction — a second declaration fails and aborts it', async () => {
    await asIssuerService(async (client) => {
      await expect(
        scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
          client.query("SELECT issuer.begin_tenant_context('all', '{}')"),
        ),
      ).rejects.toThrow(/already set for this transaction/);
      await expect(
        scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
          client.query(`SELECT issuer.begin_tenant_context('tenant', ARRAY[$1]::uuid[])`, [
            TENANT_B,
          ]),
        ),
      ).rejects.toThrow(/already set for this transaction/);
      // An injected re-declaration inside a query fails the same way.
      await expect(
        scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
          client.query(
            `SELECT id FROM issuer.tenant WHERE issuer.begin_tenant_context('all', '{}') IS NULL`,
          ),
        ),
      ).rejects.toThrow(/already set for this transaction/);
    });
  });

  it('keeps the context table out of reach of the service role', async () => {
    await asIssuerService(async (client) => {
      for (const statement of [
        'SELECT * FROM issuer.tenant_context',
        `INSERT INTO issuer.tenant_context VALUES (pg_backend_pid(), pg_current_xact_id(), 'all', '{}')`,
        "UPDATE issuer.tenant_context SET scope = 'all'",
        'DELETE FROM issuer.tenant_context',
        'TRUNCATE issuer.tenant_context',
      ]) {
        await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
      }
    });
  });

  it('rejects malformed declarations', async () => {
    await asIssuerService(async (client) => {
      for (const [scope, tenants, message] of [
        ['everything', [], /must be all or tenant/],
        ['all', [TENANT_A], /takes no tenant list/],
        ['tenant', null, /tenant list without nulls/],
      ] as const) {
        await client.query('BEGIN');
        await expect(
          client.query('SELECT issuer.begin_tenant_context($1, $2::uuid[])', [scope, tenants]),
        ).rejects.toThrow(message);
        await client.query('ROLLBACK');
      }
    });
  });

  it('never outlives its transaction on a reused connection (pooling safety)', async () => {
    await asIssuerService(async (client) => {
      // Declared outside a transaction block: applies to that statement's implicit transaction only.
      await client.query("SELECT issuer.begin_tenant_context('all', '{}')");
      expect((await client.query('SELECT id FROM issuer.tenant')).rowCount).toBe(0);

      for (const end of ['COMMIT', 'ROLLBACK']) {
        await client.query('BEGIN');
        await client.query("SELECT issuer.begin_tenant_context('all', '{}')");
        expect((await client.query('SELECT id FROM issuer.tenant')).rowCount).toBeGreaterThan(0);
        await client.query(end);
        const next = await scoped(client, 'issuer', null, [], () =>
          client.query('SELECT id FROM issuer.tenant'),
        );
        expect(next.rowCount, `after ${end}`).toBe(0);
      }
    });
  });

  it('keeps concurrent connections’ contexts apart', async () => {
    const a = new pg.Client({ connectionString: db.roleUrl('issuer-service') });
    const b = new pg.Client({ connectionString: db.roleUrl('issuer-service') });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
      await a.query(`SELECT issuer.begin_tenant_context('tenant', ARRAY[$1]::uuid[])`, [TENANT_A]);
      await b.query(`SELECT issuer.begin_tenant_context('tenant', ARRAY[$1]::uuid[])`, [TENANT_B]);
      const [seenByA, seenByB] = await Promise.all([
        a.query<{ id: string }>('SELECT id FROM issuer.tenant'),
        b.query<{ id: string }>('SELECT id FROM issuer.tenant'),
      ]);
      expect(tenantIds(seenByA.rows)).toEqual([TENANT_A]);
      expect(tenantIds(seenByB.rows)).toEqual([TENANT_B]);
    } finally {
      await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK')]);
      await Promise.all([a.end(), b.end()]);
    }
  });

  it('prevents writing into another tenant from a tenant context', async () => {
    await asIssuerService(async (client) => {
      const updated = await scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
        client.query("UPDATE issuer.tenant SET display_name = 'Hijacked' WHERE id = $1", [
          TENANT_B,
        ]),
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
        client.query('DELETE FROM issuer.tenant WHERE id = $1', [TENANT_B]),
      );
      expect(deleted.rowCount).toBe(0);
      await expect(
        scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
          client.query(
            `INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by) VALUES ($1, 9, '{}', 'x')`,
            [TENANT_B],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      // Moving one's own row into another tenant is a write into that tenant.
      await expect(
        scoped(client, 'issuer', 'tenant', [TENANT_A], () =>
          client.query(
            `INSERT INTO issuer.tenant (id, slug, display_name, internal_reference) VALUES ($1, 'sneaky', 'Sneaky', 'SN-1')`,
            [randomUUID()],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('isolates issuer memberships in identity', async () => {
    await asIdentityService(async (client) => {
      const visible = await scoped(client, 'identity', 'tenant', [TENANT_A], () =>
        client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM identity.tenant_role_assignment WHERE user_id = $1',
          [USER],
        ),
      );
      expect(visible.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      const removed = await scoped(client, 'identity', 'tenant', [TENANT_A], () =>
        client.query('DELETE FROM identity.tenant_role_assignment WHERE tenant_id = $1', [
          TENANT_B,
        ]),
      );
      expect(removed.rowCount).toBe(0);
      await expect(
        scoped(client, 'identity', 'tenant', [TENANT_A], async () => {
          await client.query("SELECT set_config('atlas.scope', 'all', true)");
          return client.query(
            `INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by)
             VALUES ($1, $2, 'issuer-administrator', 'attacker')`,
            [USER, TENANT_B],
          );
        }),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('hides platform-level and other tenants’ audit records, and allows appends only platform-wide', async () => {
    await withClient(db.roleUrl('audit-service'), async (client) => {
      const tenantView = await scoped(client, 'audit', 'tenant', [TENANT_B], () =>
        client.query('SELECT tenant_id FROM audit.audit_record'),
      );
      expect(tenantView.rowCount).toBe(0);
      const ownView = await scoped(client, 'audit', 'tenant', [TENANT_A], () =>
        client.query('SELECT tenant_id FROM audit.audit_record'),
      );
      expect(ownView.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
      await expect(
        scoped(client, 'audit', 'tenant', [TENANT_A], () =>
          client.query(
            `INSERT INTO audit.audit_record (id, chain, occurred_at, actor_type, actor_id, tenant_id, action, resource_type, resource_id, outcome, correlation_id, source_service, hash)
             VALUES ($1, $2::text, now(), 'system', 'forged', $2::uuid, 'test.forged', 'test', 'x', 'success', 'corr-0003', 'test', $3)`,
            [randomUUID(), TENANT_A, 'b'.repeat(64)],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('is what inScope() declares, and nothing leaks through the service pool', async () => {
    const logger = createLogger({
      service: 'integration',
      version: '0',
      environment: 'test',
      level: 'silent',
    });
    const connector: PostgresConnector = createPostgresConnector({
      url: db.roleUrl('issuer-service'),
      applicationName: 'integration-inscope',
      logger,
      maxConnections: 1,
      tenantContextSchema: 'issuer',
    });
    try {
      const own = await inScope(connector.pool, { kind: 'tenant', tenantIds: [TENANT_A] }, (c) =>
        c.query<{ id: string }>('SELECT id FROM issuer.tenant'),
      );
      expect(tenantIds(own.rows)).toEqual([TENANT_A]);
      // The same (single) pooled connection, used without a context, sees nothing.
      expect((await connector.pool.query('SELECT id FROM issuer.tenant')).rowCount).toBe(0);
      // A failing unit of work rolls back and leaves no context behind either.
      await expect(
        inScope(connector.pool, { kind: 'all' }, async (c) => {
          await c.query('SELECT 1');
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await connector.pool.query('SELECT id FROM issuer.tenant')).rowCount).toBe(0);
      // A tenant id that is not a UUID never reaches the database.
      await expect(
        inScope(connector.pool, { kind: 'tenant', tenantIds: ["x') OR true --"] }, async () => 1),
      ).rejects.toThrow();
    } finally {
      await connector.close();
    }
  });
});

// ============================================================================ Finding 3: permission scopes

describe('permission scopes and system roles enforced by the database (Finding 3)', () => {
  const insertRole = (client: pg.Client, key: string, scope: string, permissions: string[]) =>
    client.query(
      `INSERT INTO identity.role (key, scope, name, is_system, permissions) VALUES ($1, $2, $3, false, $4)`,
      [key, scope, `Role ${key}`, permissions],
    );

  it('mirrors the contracts catalogue', async () => {
    const rows = await withClient(db.migratorUrl, (client) =>
      client.query<{ key: string; scopes: string[] }>(
        "SELECT key, scopes FROM identity.permission WHERE key IN ('issuer.create', 'issuer.read')",
      ),
    );
    expect(Object.fromEntries(rows.rows.map((r) => [r.key, r.scopes]))).toEqual({
      'issuer.create': ['platform'],
      'issuer.read': ['platform', 'tenant'],
    });
  });

  it('refuses platform-only, unknown, duplicate and null permissions in a custom tenant role — even by direct write', async () => {
    await asIdentityService(async (client) => {
      for (const permissions of [
        ['issuer.read', 'issuer.create'],
        ['platform.users.manage'],
        ['audit.verify'],
        ['issuer.read', 'issuer.superpowers'],
        ['issuer.read', 'issuer.read'],
        ['issuer.read', null as unknown as string],
      ]) {
        await expect(
          insertRole(client, `bad-${randomUUID().slice(0, 8)}`, 'tenant', permissions),
          permissions.join(','),
        ).rejects.toThrow(/cannot hold|more than once|null permission/);
      }
      const key = `ok-${randomUUID().slice(0, 8)}`;
      await insertRole(client, key, 'tenant', ['issuer.read', 'reports.read']);
      await expect(
        client.query(
          "UPDATE identity.role SET permissions = permissions || '{platform.roles.manage}' WHERE key = $1",
          [key],
        ),
      ).rejects.toThrow(/cannot hold: platform.roles.manage/);
      // Flipping the scope of a role that is fine as a tenant role is checked as well.
      const platformKey = `ok-${randomUUID().slice(0, 8)}`;
      await insertRole(client, platformKey, 'platform', ['issuer.create']);
      await expect(
        client.query("UPDATE identity.role SET scope = 'tenant' WHERE key = $1", [platformKey]),
      ).rejects.toThrow(/cannot hold: issuer.create/);
    });
  });

  it('applies the same rules to the schema owner', async () => {
    await withClient(db.migratorUrl, async (client) => {
      await expect(
        insertRole(client, `own-${randomUUID().slice(0, 8)}`, 'tenant', ['issuer.create']),
      ).rejects.toThrow(/cannot hold: issuer.create/);
    });
  });

  it('makes system roles read-only for identity-service', async () => {
    await asIdentityService(async (client) => {
      const updated = await client.query(
        "UPDATE identity.role SET permissions = '{issuer.read,issuer.create}', scope = 'platform' WHERE key = 'customer-support'",
      );
      expect(updated.rowCount).toBe(0);
      const widened = await client.query(
        "UPDATE identity.role SET name = 'Owned' WHERE key = 'platform-super-admin'",
      );
      expect(widened.rowCount).toBe(0);
      const deleted = await client.query(
        "DELETE FROM identity.role WHERE key = 'technical-administrator'",
      );
      expect(deleted.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO identity.role (key, scope, name, is_system, permissions) VALUES ('fake-system', 'platform', 'Fake', true, '{issuer.read}')`,
        ),
      ).rejects.toThrow(/row-level security/);
      const key = `custom-${randomUUID().slice(0, 8)}`;
      await insertRole(client, key, 'tenant', ['issuer.read']);
      await expect(
        client.query('UPDATE identity.role SET is_system = true WHERE key = $1', [key]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('keeps the permission catalogue read-only for identity-service', async () => {
    await asIdentityService(async (client) => {
      expect((await client.query('SELECT key FROM identity.permission')).rowCount).toBeGreaterThan(
        10,
      );
      for (const statement of [
        "UPDATE identity.permission SET scopes = '{platform,tenant}' WHERE key = 'issuer.create'",
        "INSERT INTO identity.permission (key, scopes) VALUES ('issuer.everything', '{tenant}')",
        "DELETE FROM identity.permission WHERE key = 'issuer.create'",
      ]) {
        await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
      }
    });
  });

  it('assigns platform roles only platform-wide and tenant roles only within a tenant', async () => {
    await asIdentityService(async (client) => {
      await expect(
        scoped(client, 'identity', 'all', [], () =>
          client.query(
            `INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by)
             VALUES ($1, $2, 'platform-super-admin', 'attacker')`,
            [USER, TENANT_A],
          ),
        ),
      ).rejects.toThrow(/foreign key/);
      await expect(
        client.query(
          `INSERT INTO identity.platform_role_assignment (user_id, role_key, granted_by)
           VALUES ($1, 'issuer-administrator', 'attacker')`,
          [USER],
        ),
      ).rejects.toThrow(/foreign key/);
    });
  });

  it('refuses a catalogue change that would leave a role holding a permission outside its scope', async () => {
    await withClient(db.migratorUrl, async (client) => {
      await client.query('BEGIN');
      await client.query(
        "UPDATE identity.permission SET scopes = '{platform}' WHERE key = 'issuer.read'",
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/outside their scope/);
    });
  });

  it('restores tampered system roles from the contracts, auditing the change', async () => {
    await withClient(db.migratorUrl, async (client) => {
      const auditedSync = async () =>
        (
          await client.query(
            "SELECT 1 FROM identity.outbox WHERE envelope->'data'->>'action' = 'role.permissions.synchronised' AND envelope->'data'->'resource'->>'id' = 'reporting-user'",
          )
        ).rowCount;
      const before = await auditedSync();
      await client.query(
        "UPDATE identity.role SET permissions = '{issuer.read,reports.read,reports.export,fraud.rules.manage}' WHERE key = 'reporting-user'",
      );
      const result = await synchroniseAuthorisationCatalogue(client);
      expect(result?.rolesChanged.map((c) => c.key)).toEqual(['reporting-user']);
      const restored = await client.query<{ permissions: string[] }>(
        "SELECT permissions FROM identity.role WHERE key = 'reporting-user'",
      );
      expect(restored.rows[0]!.permissions.sort()).toEqual([
        'issuer.read',
        'reports.export',
        'reports.read',
      ]);
      expect(await auditedSync()).toBe((before ?? 0) + 1);
      // Idempotent: a second run changes nothing.
      expect((await synchroniseAuthorisationCatalogue(client))?.rolesChanged).toEqual([]);
    });
  });
});

// ============================================================================ Finding 2: synthetic data

describe('Stage 1A synthetic-only records (Finding 2)', () => {
  it('refuses a non-synthetic issuer from any role, by insert or update', async () => {
    for (const url of [db.roleUrl('issuer-service'), db.migratorUrl]) {
      await withClient(url, async (client) => {
        await expect(
          scoped(client, 'issuer', 'all', [], () =>
            client.query(
              `INSERT INTO issuer.tenant (slug, display_name, internal_reference, is_synthetic)
               VALUES ('real-bank', 'Real Bank', 'RB-1', false)`,
            ),
          ),
        ).rejects.toThrow(/tenant_stage_1a_synthetic_only/);
        await expect(
          scoped(client, 'issuer', 'all', [], () =>
            client.query('UPDATE issuer.tenant SET is_synthetic = false WHERE id = $1', [TENANT_A]),
          ),
        ).rejects.toThrow(/tenant_stage_1a_synthetic_only/);
      });
    }
    // The column default is synthetic too.
    await withClient(db.migratorUrl, async (client) => {
      const row = await client.query<{ is_synthetic: boolean }>(
        `INSERT INTO issuer.tenant (slug, display_name, internal_reference)
         VALUES ('defaulted', 'Defaulted', 'DF-1') RETURNING is_synthetic`,
      );
      expect(row.rows[0]!.is_synthetic).toBe(true);
    });
  });

  it('refuses issuer support contacts on routable email domains', async () => {
    await asIssuerService(async (client) => {
      await expect(
        scoped(client, 'issuer', 'all', [], () =>
          client.query(
            `INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by)
             VALUES ($1, 50, '{"supportContactEmail":"help@real-bank.com"}', 'x')`,
            [TENANT_A],
          ),
        ),
      ).rejects.toThrow(/tenant_configuration_stage_1a_synthetic_contact/);
    });
  });

  it('refuses non-synthetic users and real email domains from any role', async () => {
    for (const url of [db.roleUrl('identity-service'), db.migratorUrl]) {
      await withClient(url, async (client) => {
        await expect(
          client.query(
            `INSERT INTO identity.user_account (email, display_name, is_synthetic) VALUES ('real.person@gmail.com', 'Real', true)`,
          ),
        ).rejects.toThrow(/user_account_stage_1a_synthetic_email/);
        await expect(
          client.query(
            `INSERT INTO identity.user_account (email, display_name, is_synthetic) VALUES ('x@atlas.test', 'X', false)`,
          ),
        ).rejects.toThrow(/user_account_stage_1a_synthetic_only/);
        await expect(
          client.query(
            "UPDATE identity.user_account SET email = 'member@bank.co.uk' WHERE id = $1",
            [USER],
          ),
        ).rejects.toThrow(/user_account_stage_1a_synthetic_email/);
      });
    }
    for (const email of ['a@b.test', 'a@x.example', 'a@example.com', 'a@sub.example.org']) {
      await withClient(db.migratorUrl, (client) =>
        client.query(
          `INSERT INTO identity.user_account (email, display_name) VALUES ($1, 'Reserved') RETURNING is_synthetic`,
          [email],
        ),
      );
    }
  });
});

// ============================================================================ audit store

describe('append-only audit store', () => {
  it('gives audit-service no UPDATE or DELETE privilege', async () => {
    await withClient(db.roleUrl('audit-service'), async (client) => {
      await expect(
        scoped(client, 'audit', 'all', [], () =>
          client.query("UPDATE audit.audit_record SET action = 'tampered'"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        scoped(client, 'audit', 'all', [], () => client.query('DELETE FROM audit.audit_record')),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query('TRUNCATE audit.audit_record')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it('rejects UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
    await withClient(db.migratorUrl, async (client) => {
      await expect(
        client.query("UPDATE audit.audit_record SET action = 'tampered'"),
      ).rejects.toThrow(/append-only/);
      await expect(client.query('DELETE FROM audit.audit_record')).rejects.toThrow(/append-only/);
      await expect(client.query('TRUNCATE audit.audit_record')).rejects.toThrow(/append-only/);
    });
  });

  it('makes issuer configuration versions immutable', async () => {
    await withClient(db.migratorUrl, async (client) => {
      await client.query(
        `INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by) VALUES ($1, 1, '{}', 'test')`,
        [TENANT_A],
      );
      await expect(
        client.query('UPDATE issuer.tenant_configuration SET settings = $1', ['{"x":1}']),
      ).rejects.toThrow(/immutable/);
    });
  });
});

describe('transactional outbox', () => {
  it('keeps an audit event only if the change it describes commits', async () => {
    await asIssuerService(async (client) => {
      const committedId = randomUUID();
      const rolledBackId = randomUUID();
      for (const [id, commit] of [
        [committedId, true],
        [rolledBackId, false],
      ] as const) {
        await client.query('BEGIN');
        await client.query("SELECT issuer.begin_tenant_context('all', '{}')");
        await client.query("UPDATE issuer.tenant SET display_name = 'Changed' WHERE id = $1", [
          TENANT_A,
        ]);
        await client.query(
          `INSERT INTO issuer.outbox (id, event_type, envelope) VALUES ($1, 'atlas.test.changed.v1', '{}')`,
          [id],
        );
        await client.query(commit ? 'COMMIT' : 'ROLLBACK');
      }
      const rows = await client.query('SELECT id FROM issuer.outbox WHERE id = ANY($1)', [
        [committedId, rolledBackId],
      ]);
      expect(rows.rows.map((r) => r.id)).toEqual([committedId]);
    });
  });
});
