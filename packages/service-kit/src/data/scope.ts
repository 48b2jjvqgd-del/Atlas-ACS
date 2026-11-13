import { tenantIdSchema } from '@atlas/schemas';
import pg from 'pg';
import type { TenantScope } from '../auth/access.js';

/**
 * Tenant-scoped database access (Stage 1A).
 *
 * All access to tenant-owned tables goes through `inScope`, which opens a transaction and declares
 * the row-level-security context before running the callback:
 *
 *   SELECT <schema>.begin_tenant_context('all' | 'tenant', '{uuid,...}')
 *
 * The context is held by the database, not in a session setting: it lives in a table the service
 * role cannot read or write, is keyed on the backend and the transaction id, and can be declared
 * only once per transaction (see database/migrations/<schema>/*_tenant-context-hardening.sql).
 * Consequently:
 *
 *   - set_config()/SET cannot change what a transaction sees (the policies no longer read settings);
 *   - an injected expression inside a tenant-scoped transaction cannot widen or replace its scope;
 *   - nothing can leak to the next transaction on a pooled connection (different transaction id).
 *
 * The guarantee is bounded: code holding the service's database credentials can still open its own
 * transaction and declare platform-wide scope, as the service legitimately does for platform
 * administrators. RLS therefore protects against query mistakes and injection within a request,
 * not against a fully compromised service process. See SECURITY_MODEL.md, "Tenant isolation".
 *
 * There is deliberately no unscoped query helper.
 */
export type Queryable = Pick<pg.PoolClient, 'query'>;

const contextSchemas = new WeakMap<pg.Pool, string>();
const schemaName = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Associates a pool with the schema whose `begin_tenant_context` function declares the RLS
 * context. The runtime does this for every service from its catalogue entry.
 */
export function bindTenantContext(pool: pg.Pool, schema: string): pg.Pool {
  if (!schemaName.test(schema))
    throw new Error(`Invalid schema name for tenant context: ${schema}`);
  contextSchemas.set(pool, schema);
  return pool;
}

export async function inScope<T>(
  pool: pg.Pool,
  scope: TenantScope,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const schema = contextSchemas.get(pool);
  // Fail closed: without a context function no tenant row would be visible anyway, but a clear
  // error is better than an empty result.
  if (!schema) throw new Error('inScope: pool has no tenant-context schema (bindTenantContext)');
  const tenantIds =
    scope.kind === 'all' ? [] : scope.tenantIds.map((id) => tenantIdSchema.parse(id));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT ${pg.escapeIdentifier(schema)}.begin_tenant_context($1, $2::uuid[])`,
      [scope.kind, tenantIds],
    );
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Platform-wide scope for service-internal work (relays, consumers, principal resolution). */
export const systemScope: TenantScope = { kind: 'all' };

/** True for a PostgreSQL unique-violation error, optionally on a specific constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
