import { createHash } from 'node:crypto';
import type { ActivityRecorded, AuditQuery, AuditRecord, EventEnvelope } from '@atlas/contracts';
import type { Queryable } from '@atlas/service-kit';

/**
 * Append-only, hash-chained audit store.
 *
 * Each record's hash is SHA-256 over a canonical JSON serialisation of its content plus the hash
 * of the previous record in the same chain (one chain per issuer, one "platform" chain). Changing,
 * removing or reordering any stored record breaks every later hash in its chain, which
 * `verifyChain` detects. Records are inserted under a per-chain advisory lock so the chain is
 * strictly ordered even with concurrent consumers.
 */
export function chainOf(tenantId: string | undefined | null): string {
  return tenantId ?? 'platform';
}

/** JSON with object keys sorted recursively, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

interface HashInput {
  id: string;
  chain: string;
  occurredAt: string;
  actor: ActivityRecorded['actor'];
  tenantId: string | null;
  action: string;
  resource: ActivityRecorded['resource'];
  outcome: string;
  correlationId: string;
  sourceService: string;
  changes: ActivityRecorded['changes'] | null;
  metadata: ActivityRecorded['metadata'] | null;
  reason: string | null;
  previousHash: string | null;
}

export function recordHash(input: HashInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

const serviceFromSource = (source: string) => source.replace(/^urn:atlas:service:/, '');

/** Stores an event. Returns false when it was already stored (redelivery): idempotent. */
export async function appendRecord(
  client: Queryable,
  event: EventEnvelope<ActivityRecorded>,
): Promise<boolean> {
  const data = event.data;
  const tenantId = data.tenantId ?? null;
  const chain = chainOf(tenantId);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`audit-chain:${chain}`]);
  const exists = await client.query('SELECT 1 FROM audit.audit_record WHERE id = $1', [event.id]);
  if ((exists.rowCount ?? 0) > 0) return false;
  const head = await client.query<{ hash: string }>(
    'SELECT hash FROM audit.audit_record WHERE chain = $1 ORDER BY sequence DESC LIMIT 1',
    [chain],
  );
  const previousHash = head.rows[0]?.hash ?? null;
  // Normalise the timestamp so the stored value and the hashed value are identical.
  const occurredAt = new Date(data.occurredAt).toISOString();
  const input: HashInput = {
    id: event.id,
    chain,
    occurredAt,
    actor: data.actor,
    tenantId,
    action: data.action,
    resource: data.resource,
    outcome: data.outcome,
    correlationId: event.correlationid,
    sourceService: serviceFromSource(event.source),
    changes: data.changes ?? null,
    metadata: data.metadata ?? null,
    reason: data.reason ?? null,
    previousHash,
  };
  await client.query(
    `INSERT INTO audit.audit_record
       (id, chain, occurred_at, actor_type, actor_id, actor_display, tenant_id, action, resource_type,
        resource_id, resource_name, outcome, correlation_id, source_service, changes, metadata, reason,
        previous_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.id,
      chain,
      occurredAt,
      data.actor.type,
      data.actor.id,
      data.actor.displayName ?? null,
      tenantId,
      data.action,
      data.resource.type,
      data.resource.id,
      data.resource.name ?? null,
      data.outcome,
      input.correlationId,
      input.sourceService,
      input.changes ? JSON.stringify(input.changes) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.reason,
      previousHash,
      recordHash(input),
    ],
  );
  return true;
}

interface RecordRow {
  id: string;
  sequence: string;
  chain: string;
  occurred_at: Date;
  recorded_at: Date;
  actor_type: AuditRecord['actor']['type'];
  actor_id: string;
  actor_display: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  resource_name: string | null;
  outcome: AuditRecord['outcome'];
  correlation_id: string;
  source_service: string;
  changes: AuditRecord['changes'];
  metadata: AuditRecord['metadata'];
  reason: string | null;
  previous_hash: string | null;
  hash: string;
}

function toRecord(row: RecordRow): AuditRecord {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      ...(row.actor_display ? { displayName: row.actor_display } : {}),
    },
    tenantId: row.tenant_id,
    action: row.action,
    resource: {
      type: row.resource_type,
      id: row.resource_id,
      ...(row.resource_name ? { name: row.resource_name } : {}),
    },
    outcome: row.outcome,
    correlationId: row.correlation_id,
    sourceService: row.source_service,
    changes: row.changes,
    metadata: row.metadata,
    reason: row.reason,
    chain: row.chain,
    hash: row.hash,
    previousHash: row.previous_hash,
  };
}

export async function queryRecords(
  client: Queryable,
  query: AuditQuery,
): Promise<{ records: AuditRecord[]; nextBefore: number | null }> {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (query.tenantId) add('tenant_id = ?', query.tenantId);
  if (query.action) {
    // "issuer." matches every issuer action; an exact action matches only itself.
    if (query.action.endsWith('.'))
      add('action LIKE ?', `${query.action.replaceAll(/[\\%_]/g, '\\$&')}%`);
    else add('action = ?', query.action);
  }
  if (query.actorId) add('actor_id = ?', query.actorId);
  if (query.resourceType) add('resource_type = ?', query.resourceType);
  if (query.resourceId) add('resource_id = ?', query.resourceId);
  if (query.outcome) add('outcome = ?', query.outcome);
  if (query.from) add('occurred_at >= ?', query.from);
  if (query.to) add('occurred_at <= ?', query.to);
  if (query.before) add('sequence < ?', query.before);
  values.push(query.limit + 1);
  const result = await client.query<RecordRow>(
    `SELECT * FROM audit.audit_record ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY sequence DESC LIMIT $${values.length}`,
    values,
  );
  const records = result.rows.slice(0, query.limit).map(toRecord);
  const nextBefore = result.rows.length > query.limit ? (records.at(-1)?.sequence ?? null) : null;
  return { records, nextBefore };
}

export async function findRecord(client: Queryable, id: string): Promise<AuditRecord | undefined> {
  const result = await client.query<RecordRow>('SELECT * FROM audit.audit_record WHERE id = $1', [
    id,
  ]);
  return result.rows[0] ? toRecord(result.rows[0]) : undefined;
}

export async function verifyChain(
  client: Queryable,
  chain: string,
): Promise<{
  records: number;
  valid: boolean;
  firstInvalidSequence: number | null;
  headHash: string | null;
}> {
  const result = await client.query<RecordRow>(
    'SELECT * FROM audit.audit_record WHERE chain = $1 ORDER BY sequence',
    [chain],
  );
  let previous: string | null = null;
  for (const row of result.rows) {
    const record = toRecord(row);
    const expected = recordHash({
      id: record.id,
      chain: record.chain,
      occurredAt: record.occurredAt,
      actor: record.actor,
      tenantId: record.tenantId,
      action: record.action,
      resource: record.resource,
      outcome: record.outcome,
      correlationId: record.correlationId,
      sourceService: record.sourceService,
      changes: record.changes,
      metadata: record.metadata,
      reason: record.reason,
      previousHash: previous,
    });
    if (record.previousHash !== previous || record.hash !== expected) {
      return {
        records: result.rows.length,
        valid: false,
        firstInvalidSequence: record.sequence,
        headHash: null,
      };
    }
    previous = record.hash;
  }
  return {
    records: result.rows.length,
    valid: true,
    firstInvalidSequence: null,
    headHash: previous,
  };
}
