import { tenantIdSchema } from '@atlas/schemas';
import type pg from 'pg';
import type { TenantScope } from '../auth/access.js';

/**
 * Tenant-scoped database access (Stage 1A).
 *
 * All access to tenant-owned tables goes through `inScope`, which opens a transaction and sets the
 * row-level-security context before running the callback:
 *
 *   atlas.scope       'all' | 'tenant'
 *   atlas.tenant_ids  '{uuid,...}'
 *
 * The settings are transaction-local (set_config(..., true)), so they can never leak to another
 * request through the connection pool. PostgreSQL policies on every tenant-owned table then hide
 * rows outside the scope even if a query forgets its tenant predicate — defence in depth behind
 * the service's own authorisation. There is deliberately no unscoped query helper.
 */
export type Queryable = Pick<pg.PoolClient, 'query'>;

export async function inScope<T>(
  pool: pg.Pool,
  scope: TenantScope,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const tenantIds =
    scope.kind === 'all' ? [] : scope.tenantIds.map((id) => tenantIdSchema.parse(id));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('atlas.scope', $1, true), set_config('atlas.tenant_ids', $2, true)",
      [scope.kind, `{${tenantIds.join(',')}}`],
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
