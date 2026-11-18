import {
  activityRecordedV1,
  isSensitiveFieldName,
  type ActivityRecorded,
  type AuditChange,
  type ServiceName,
} from '@atlas/contracts';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AccessDeniedEvent } from './auth/access.js';
import { enqueueEvent } from './data/outbox.js';
import { inScope, systemScope, type Queryable } from './data/scope.js';
import { buildEnvelope } from './messaging.js';

/**
 * Audit capture helpers (Stage 1A).
 *
 * Producers describe *what happened*; audit-service stores it append-only with a hash chain.
 * Changes are recorded inside the same database transaction as the change itself (outbox), so an
 * audited change can never commit without its audit record.
 *
 * Data minimisation: only fields on an explicit allow-list are recorded with before/after values,
 * and field names that look like secrets are refused even if allow-listed.
 */
export type AuditEntry = Omit<ActivityRecorded, 'occurredAt'> & { occurredAt?: string };

/** The actor for an audit record, derived from the verified request context. */
export function actorOf(request: FastifyRequest): ActivityRecorded['actor'] {
  if (request.principal) {
    return {
      type: 'user',
      id: request.principal.userId,
      displayName: request.principal.displayName,
    };
  }
  if (request.user) return { type: 'user', id: request.user.subject };
  if (request.caller) return { type: 'service', id: request.caller };
  return { type: 'anonymous', id: 'anonymous' };
}

type Scalar = string | number | boolean | null;

/**
 * Before/after values for the allow-listed fields that actually changed. Values that are not
 * scalars are serialised to short JSON strings.
 */
export function diffFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  allowList: readonly string[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of allowList) {
    if (isSensitiveFieldName(field)) throw new Error(`Refusing to audit sensitive field ${field}`);
    const previous = toScalar(readPath(before, field));
    const next = toScalar(readPath(after, field));
    if (previous !== next) changes.push({ field, before: previous, after: next });
  }
  return changes;
}

function readPath(source: Record<string, unknown> | null, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[segment];
  }
  return value ?? null;
}

function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value).slice(0, 500);
}

export interface AuditWriterOptions {
  service: ServiceName;
  /** Schema holding this service's outbox table. */
  schema: string;
}

export function createAuditWriter(options: AuditWriterOptions) {
  const envelopeFor = (entry: AuditEntry, correlationId: string) =>
    buildEnvelope(
      activityRecordedV1,
      { ...entry, occurredAt: entry.occurredAt ?? new Date().toISOString() },
      {
        service: options.service,
        correlationId,
        ...(entry.tenantId ? { tenantId: entry.tenantId } : {}),
      },
    );

  return {
    /** Records an audit entry inside the caller's transaction (transactional outbox). */
    async record(client: Queryable, correlationId: string, entry: AuditEntry): Promise<void> {
      await enqueueEvent(client, options.schema, envelopeFor(entry, correlationId));
    },
    /** Records an entry in its own transaction (e.g. access denied: there is no business change). */
    async recordDetached(pool: pg.Pool, correlationId: string, entry: AuditEntry): Promise<void> {
      await inScope(pool, systemScope, (client) =>
        enqueueEvent(client, options.schema, envelopeFor(entry, correlationId)),
      );
    },
  };
}

export type AuditWriter = ReturnType<typeof createAuditWriter>;

/** The audit entry for a denied request: who, what route, which permission, why. */
export function accessDeniedEntry(event: AccessDeniedEvent): AuditEntry {
  const { request } = event;
  const route = request.routeOptions.url ?? 'unmatched';
  // A cross-tenant attempt is recorded on the platform chain, not in the target issuer's trail:
  // the target issuer must not learn about another issuer's users. Platform security sees it.
  const crossTenant = event.reason === 'tenant-not-accessible';
  return {
    actor: actorOf(request),
    ...(event.tenantId && !crossTenant ? { tenantId: event.tenantId } : {}),
    action: 'access.denied',
    resource: { type: 'api-route', id: `${request.method} ${route}`.slice(0, 128) },
    outcome: 'denied',
    metadata: {
      reason: event.reason,
      permission: event.permission ?? null,
      caller: request.caller ?? null,
      method: request.method,
      targetTenantId: crossTenant ? (event.tenantId ?? null) : null,
    },
  };
}
