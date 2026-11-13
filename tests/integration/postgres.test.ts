import { randomBytes } from 'node:crypto';
import { migrate, migrationStatus, runSeeds } from '@atlas/database';
import { createLogger } from '@atlas/observability';
import { createPostgresConnector } from '@atlas/service-kit';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { infrastructure, withCredentials } from './env.js';

const logger = createLogger({
  service: 'integration',
  version: '0.0.0',
  environment: 'test',
  level: 'silent',
});

// Each run uses a throwaway database so tests never touch developer data.
const databaseName = `atlas_it_${randomBytes(4).toString('hex')}`;
const adminUrl = infrastructure.databaseUrl;
const testUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await admin((client) => client.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`));
});

afterAll(async () => {
  await admin((client) =>
    client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`),
  );
});

describe('PostgreSQL connectivity', () => {
  it('passes the readiness check against a reachable database', async () => {
    const connector = createPostgresConnector({
      url: testUrl,
      applicationName: 'integration',
      logger,
    });
    await expect(connector.check()).resolves.toBeUndefined();
    await connector.close();
  });

  it('fails the readiness check with wrong credentials', async () => {
    const connector = createPostgresConnector({
      url: withCredentials(testUrl, 'wrong-password'),
      applicationName: 'integration',
      logger,
    });
    await expect(connector.check()).rejects.toThrow();
    await connector.close();
  });
});

describe('migrations', () => {
  it('applies, reports, rolls back and re-applies owner migrations', async () => {
    const up = await migrate({ databaseUrl: testUrl, direction: 'up' });
    expect(up.issuer?.map((m) => m.name)).toEqual([
      '20261106000000_create-tenant',
      '20261109090000_issuer-registry-foundations',
      '20261113090000_tenant-context-hardening',
      '20261113091000_stage-1a-synthetic-only',
    ]);
    expect(up.identity?.length).toBeGreaterThan(0);
    expect(up.audit?.length).toBeGreaterThan(0);

    let status = await migrationStatus(testUrl);
    expect(status.find((s) => s.schema === 'issuer')).toMatchObject({
      pending: [],
      service: 'issuer-service',
    });

    const noop = await migrate({ databaseUrl: testUrl, direction: 'up' });
    expect(noop.issuer).toEqual([]);

    await migrate({ databaseUrl: testUrl, direction: 'down', owner: 'issuer', count: 4 });
    status = await migrationStatus(testUrl);
    expect(status.find((s) => s.schema === 'issuer')?.applied).toEqual([]);
    const tableGone = await admin(async () => {
      const client = new pg.Client({ connectionString: testUrl });
      await client.connect();
      const result = await client.query<{ present: boolean }>(
        "SELECT to_regclass('issuer.tenant') IS NOT NULL AS present",
      );
      await client.end();
      return !result.rows[0]?.present;
    });
    expect(tableGone).toBe(true);

    await migrate({ databaseUrl: testUrl, direction: 'up' });
  });

  it("keeps each owner's migration history inside its own schema", async () => {
    const client = new pg.Client({ connectionString: testUrl });
    await client.connect();
    const result = await client.query<{ present: boolean }>(
      "SELECT to_regclass('issuer.pgmigrations') IS NOT NULL AS present",
    );
    const publicTable = await client.query<{ present: boolean }>(
      "SELECT to_regclass('public.pgmigrations') IS NOT NULL AS present",
    );
    await client.end();
    expect(result.rows[0]?.present).toBe(true);
    expect(publicTable.rows[0]?.present).toBe(false);
  });

  it('enforces tenant constraints at the database level', async () => {
    const client = new pg.Client({ connectionString: testUrl });
    await client.connect();
    try {
      await expect(
        client.query("INSERT INTO issuer.tenant (slug, display_name) VALUES ('Not A Slug', 'x')"),
      ).rejects.toThrow(/tenant_slug_format/);
      await expect(
        client.query(
          "INSERT INTO issuer.tenant (slug, display_name, status) VALUES ('ok-slug', 'x', 'deleted')",
        ),
      ).rejects.toThrow(/tenant_status_valid/);
      const inserted = await client.query<{ created_at: Date; updated_at: Date }>(
        "INSERT INTO issuer.tenant (slug, display_name) VALUES ('it-tenant', 'IT Tenant') RETURNING created_at, updated_at",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const updated = await client.query<{ updated_at: Date }>(
        "UPDATE issuer.tenant SET display_name = 'Renamed' WHERE slug = 'it-tenant' RETURNING updated_at",
      );
      expect(updated.rows[0]!.updated_at.getTime()).toBeGreaterThan(
        inserted.rows[0]!.updated_at.getTime(),
      );
    } finally {
      await client.end();
    }
  });

  it('seeds synthetic data idempotently', async () => {
    await runSeeds({ databaseUrl: testUrl, environment: 'test' });
    await runSeeds({ databaseUrl: testUrl, environment: 'test' });
    const client = new pg.Client({ connectionString: testUrl });
    await client.connect();
    const rows = await client.query<{ seeded: string; count: string; synthetic: string }>(
      `SELECT count(*) FILTER (WHERE slug IN ('northstar-bank', 'meridian-financial', 'harbourline-credit-union')) AS seeded,
              count(*) AS count, count(*) FILTER (WHERE is_synthetic) AS synthetic FROM issuer.tenant`,
    );
    await client.end();
    expect(rows.rows[0]!.seeded).toBe('3');
    // Stage 1A: every issuer is synthetic, including ones inserted without saying so.
    expect(rows.rows[0]!.synthetic).toBe(rows.rows[0]!.count);
  });
});
