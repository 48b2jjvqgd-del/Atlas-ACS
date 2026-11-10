import { randomBytes, randomUUID } from 'node:crypto';
import { applyServiceGrants, migrate, provisionDatabaseRoles, serviceRoles } from '@atlas/database';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infrastructure } from './env.js';

/**
 * ADR-012 credentials gate and tenant isolation in the database itself.
 *
 * A throwaway database is provisioned exactly as in a real environment (roles → migrations as
 * atlas_migrator → grants), then each service role is exercised directly. Roles are cluster-wide;
 * provisioning is idempotent and uses the passwords from the environment.
 */
const databaseName = `atlas_it_sec_${randomBytes(4).toString('hex')}`;
const adminUrl = infrastructure.databaseUrl;
const urlFor = (user: string, password: string, database = databaseName) => {
  const url = new URL(adminUrl);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};
const adminTestUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();

const password = (variable: string) => {
  const value = process.env[variable];
  if (!value) throw new Error(`${variable} is not set: run pnpm setup:env`);
  return value;
};
const servicePasswords = Object.fromEntries(
  serviceRoles().map(({ service }) => [
    service,
    password(`DB_PASSWORD_${service.replaceAll('-', '_').toUpperCase()}`),
  ]),
);
const migratorUrl = urlFor('atlas_migrator', password('DB_PASSWORD_MIGRATOR'));
const roleUrl = (service: string) =>
  urlFor(`atlas_${service.replaceAll('-', '_')}`, servicePasswords[service]!);

async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Runs statements in a transaction with the row-level-security scope set, then rolls back. */
async function scoped<T>(
  client: pg.Client,
  scope: 'all' | 'tenant' | null,
  tenants: string[],
  work: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    if (scope) {
      await client.query(
        "SELECT set_config('atlas.scope', $1, true), set_config('atlas.tenant_ids', $2, true)",
        [scope, `{${tenants.join(',')}}`],
      );
    }
    return await work();
  } finally {
    await client.query('ROLLBACK');
  }
}

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

beforeAll(async () => {
  await withClient(adminUrl, (client) =>
    client.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`),
  );
  await provisionDatabaseRoles({
    adminUrl: adminTestUrl,
    migratorPassword: password('DB_PASSWORD_MIGRATOR'),
    servicePasswords,
  });
  await migrate({ databaseUrl: migratorUrl, direction: 'up' });
  await withClient(migratorUrl, async (client) => {
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
  });
}, 120_000);

afterAll(async () => {
  await withClient(adminUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`),
  );
});

describe('per-service database credentials (ADR-012)', () => {
  it('lets each service role use its own schema only', async () => {
    const tables: Record<string, string> = {
      issuer: 'issuer.tenant',
      identity: 'identity.user_account',
      audit: 'audit.audit_record',
    };
    for (const { service, schema } of serviceRoles()) {
      await withClient(roleUrl(service), async (client) => {
        for (const [owner, table] of Object.entries(tables)) {
          const attempt = client.query(`SELECT count(*) FROM ${table}`);
          if (owner === schema)
            await expect(attempt, `${service} → own ${table}`).resolves.toBeDefined();
          else await expect(attempt, `${service} → ${table}`).rejects.toThrow(/permission denied/);
        }
      });
    }
  });

  it('denies DDL, the public schema and migration history to service roles', async () => {
    await withClient(roleUrl('issuer-service'), async (client) => {
      await expect(client.query('CREATE TABLE issuer.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('CREATE TABLE public.sneaky (id int)')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DROP TABLE issuer.tenant')).rejects.toThrow(/must be owner/);
      await expect(client.query('SELECT * FROM issuer.pgmigrations')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        client.query('ALTER TABLE issuer.tenant DISABLE ROW LEVEL SECURITY'),
      ).rejects.toThrow(/must be owner/);
    });
  });

  it('cannot connect with another service’s password', async () => {
    const wrong = urlFor('atlas_issuer_service', servicePasswords['audit-service']!);
    await expect(withClient(wrong, (client) => client.query('SELECT 1'))).rejects.toThrow(
      /password authentication failed/,
    );
  });

  it('re-applies grants idempotently', async () => {
    const applied = await withClient(migratorUrl, (client) => applyServiceGrants(client));
    expect(applied).toEqual(
      expect.arrayContaining([
        'issuer → atlas_issuer_service (read-write)',
        'audit → atlas_audit_service (append-only)',
      ]),
    );
  });
});

describe('row-level security (defence in depth)', () => {
  it('shows no tenant rows without a scope', async () => {
    await withClient(roleUrl('issuer-service'), async (client) => {
      const rows = await scoped(client, null, [], () =>
        client.query('SELECT id FROM issuer.tenant'),
      );
      expect(rows.rowCount).toBe(0);
    });
  });

  it('limits a tenant scope to its own tenants, even with no WHERE clause', async () => {
    await withClient(roleUrl('issuer-service'), async (client) => {
      const rows = await scoped(client, 'tenant', [TENANT_A], () =>
        client.query('SELECT id FROM issuer.tenant'),
      );
      expect(rows.rows.map((r) => r.id)).toEqual([TENANT_A]);
      const all = await scoped(client, 'all', [], () =>
        client.query('SELECT id FROM issuer.tenant'),
      );
      expect(all.rowCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('prevents writing into another tenant from a tenant scope', async () => {
    await withClient(roleUrl('issuer-service'), async (client) => {
      const updated = await scoped(client, 'tenant', [TENANT_A], () =>
        client.query("UPDATE issuer.tenant SET display_name = 'Hijacked' WHERE id = $1", [
          TENANT_B,
        ]),
      );
      expect(updated.rowCount).toBe(0);
      await expect(
        scoped(client, 'tenant', [TENANT_A], () =>
          client.query(
            `INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by) VALUES ($1, 9, '{}', 'x')`,
            [TENANT_B],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('hides platform-level and other tenants’ audit records from a tenant scope', async () => {
    await withClient(roleUrl('audit-service'), async (client) => {
      const tenantView = await scoped(client, 'tenant', [TENANT_B], () =>
        client.query('SELECT tenant_id FROM audit.audit_record'),
      );
      expect(tenantView.rowCount).toBe(0);
      const ownView = await scoped(client, 'tenant', [TENANT_A], () =>
        client.query('SELECT tenant_id FROM audit.audit_record'),
      );
      expect(ownView.rows.map((r) => r.tenant_id)).toEqual([TENANT_A]);
    });
  });
});

describe('append-only audit store', () => {
  it('gives audit-service no UPDATE or DELETE privilege', async () => {
    await withClient(roleUrl('audit-service'), async (client) => {
      await expect(
        scoped(client, 'all', [], () =>
          client.query("UPDATE audit.audit_record SET action = 'tampered'"),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        scoped(client, 'all', [], () => client.query('DELETE FROM audit.audit_record')),
      ).rejects.toThrow(/permission denied/);
      await expect(client.query('TRUNCATE audit.audit_record')).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it('rejects UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
    await withClient(migratorUrl, async (client) => {
      await expect(
        client.query("UPDATE audit.audit_record SET action = 'tampered'"),
      ).rejects.toThrow(/append-only/);
      await expect(client.query('DELETE FROM audit.audit_record')).rejects.toThrow(/append-only/);
      await expect(client.query('TRUNCATE audit.audit_record')).rejects.toThrow(/append-only/);
    });
  });

  it('makes issuer configuration versions immutable', async () => {
    await withClient(migratorUrl, async (client) => {
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
    await withClient(roleUrl('issuer-service'), async (client) => {
      const committedId = randomUUID();
      const rolledBackId = randomUUID();
      for (const [id, commit] of [
        [committedId, true],
        [rolledBackId, false],
      ] as const) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('atlas.scope', 'all', true)");
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
