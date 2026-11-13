import { randomUUID } from 'node:crypto';
import { activityRecordedV1, type ActivityRecorded, type EventEnvelope } from '@atlas/contracts';
import { appendRecord, chainOf, verifyChain } from '@atlas/audit-service/store';
import { createLogger } from '@atlas/observability';
import { buildEnvelope, createPostgresConnector, inScope, systemScope } from '@atlas/service-kit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from './database.js';

/**
 * Audit integrity against a real database: events are appended exactly as the audit consumer does
 * (audit-service credentials, platform-wide context), then a database superuser — the one party
 * the append-only privileges and triggers do not stop — tampers with stored rows. The hash chain
 * must expose modification, deletion and reordering.
 */
let db: TestDatabase;
let connector: ReturnType<typeof createPostgresConnector>;
const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});

beforeAll(async () => {
  db = await createTestDatabase('audit');
  connector = createPostgresConnector({
    url: db.roleUrl('audit-service'),
    applicationName: 'integration-audit',
    logger,
    tenantContextSchema: 'audit',
  });
}, 120_000);

afterAll(async () => {
  await connector?.close();
  await db?.drop();
});

const event = (tenantId: string, n: number): EventEnvelope<ActivityRecorded> =>
  buildEnvelope(
    activityRecordedV1,
    {
      occurredAt: new Date(Date.UTC(2026, 10, 13, 9, 0, n)).toISOString(),
      actor: { type: 'user', id: randomUUID(), displayName: `Synthetic user ${n}` },
      tenantId,
      action: 'issuer.updated',
      resource: { type: 'issuer', id: tenantId, name: 'Synthetic Issuer' },
      outcome: 'success',
      changes: [{ field: 'displayName', before: `Name ${n}`, after: `Name ${n + 1}` }],
    },
    { service: 'issuer-service', correlationId: `correlation-${n}`, tenantId },
  );

async function chainWith(count: number): Promise<{ tenantId: string; ids: string[] }> {
  const tenantId = randomUUID();
  const ids: string[] = [];
  for (let n = 0; n < count; n += 1) {
    const envelope = event(tenantId, n);
    ids.push(envelope.id);
    await inScope(connector.pool, systemScope, (client) => appendRecord(client, envelope));
  }
  return { tenantId, ids };
}

const verify = (tenantId: string) =>
  inScope(connector.pool, systemScope, (client) => verifyChain(client, chainOf(tenantId)));

/** Superuser access with triggers disabled for the session: the strongest tampering available. */
const tamper = (statement: string, values: unknown[]) =>
  withClient(db.adminUrl, async (client: pg.Client) => {
    await client.query('SET session_replication_role = replica');
    await client.query(statement, values);
  });

describe('audit hash chain', () => {
  it('verifies an untouched chain and ignores redelivered events', async () => {
    const { tenantId } = await chainWith(4);
    const first = await verify(tenantId);
    expect(first).toMatchObject({ records: 4, valid: true, firstInvalidSequence: null });

    const duplicate = event(tenantId, 99);
    expect(await inScope(connector.pool, systemScope, (c) => appendRecord(c, duplicate))).toBe(
      true,
    );
    expect(await inScope(connector.pool, systemScope, (c) => appendRecord(c, duplicate))).toBe(
      false,
    );
    expect(await verify(tenantId)).toMatchObject({ records: 5, valid: true });
  });

  it('accepts events from registered producers only', async () => {
    const forged = { ...event(randomUUID(), 0), source: 'urn:atlas:service:fraud-engine' };
    await expect(
      inScope(connector.pool, systemScope, (client) => appendRecord(client, forged)),
    ).rejects.toThrow(/unregistered producer/);
  });

  it('detects a modified record', async () => {
    const { tenantId, ids } = await chainWith(4);
    await tamper("UPDATE audit.audit_record SET outcome = 'failure' WHERE id = $1", [ids[1]]);
    const result = await verify(tenantId);
    expect(result.valid).toBe(false);
    const sequence = await withClient(db.adminUrl, (c) =>
      c.query<{ sequence: string }>('SELECT sequence FROM audit.audit_record WHERE id = $1', [
        ids[1],
      ]),
    );
    expect(result.firstInvalidSequence).toBe(Number(sequence.rows[0]!.sequence));
  });

  it('detects a modified record even when its own hash is recomputed', async () => {
    const { tenantId, ids } = await chainWith(4);
    // Rewriting a record and its hash still breaks the link from the next record.
    await tamper(
      "UPDATE audit.audit_record SET reason = 'covered up', hash = repeat('c', 64) WHERE id = $1",
      [ids[1]],
    );
    expect((await verify(tenantId)).valid).toBe(false);
  });

  it('detects a deleted record', async () => {
    const { tenantId, ids } = await chainWith(4);
    await tamper('DELETE FROM audit.audit_record WHERE id = $1', [ids[2]]);
    expect(await verify(tenantId)).toMatchObject({ records: 3, valid: false });
  });

  it('detects reordered records', async () => {
    const { tenantId, ids } = await chainWith(4);
    // Swap the content and hashes of two adjacent rows (sequence is an identity column and keeps
    // its order), as if they had been stored the other way round.
    await tamper(
      `WITH a AS (SELECT * FROM audit.audit_record WHERE id = $1), b AS (SELECT * FROM audit.audit_record WHERE id = $2)
       UPDATE audit.audit_record r SET
         occurred_at = CASE WHEN r.id = a.id THEN b.occurred_at ELSE a.occurred_at END,
         actor_id = CASE WHEN r.id = a.id THEN b.actor_id ELSE a.actor_id END,
         actor_display = CASE WHEN r.id = a.id THEN b.actor_display ELSE a.actor_display END,
         changes = CASE WHEN r.id = a.id THEN b.changes ELSE a.changes END,
         correlation_id = CASE WHEN r.id = a.id THEN b.correlation_id ELSE a.correlation_id END,
         previous_hash = CASE WHEN r.id = a.id THEN b.previous_hash ELSE a.previous_hash END,
         hash = CASE WHEN r.id = a.id THEN b.hash ELSE a.hash END
       FROM a, b WHERE r.id IN (a.id, b.id)`,
      [ids[1], ids[2]],
    );
    expect((await verify(tenantId)).valid).toBe(false);
  });

  it('exposes truncation of the newest records only against a recorded head hash (anchoring)', async () => {
    const { tenantId, ids } = await chainWith(3);
    const before = await verify(tenantId);
    await tamper('DELETE FROM audit.audit_record WHERE id = $1', [ids[2]]);
    const after = await verify(tenantId);
    // The shorter chain is internally consistent — a documented limitation until chain heads are
    // anchored outside the database — but its head no longer matches the recorded one.
    expect(after.valid).toBe(true);
    expect(after.headHash).not.toBe(before.headHash);
  });
});
