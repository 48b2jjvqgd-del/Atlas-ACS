import {
  issuerSettingsSchema,
  type IssuerSettings,
  type TenantConfiguration,
  type TenantStatus,
  type TenantSummary,
} from '@atlas/contracts';
import type { Queryable } from '@atlas/service-kit';

/** issuer schema access. Callers pass a client inside a scoped transaction (inScope). */
interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  internal_reference: string | null;
  status: TenantStatus;
  is_synthetic: boolean;
  created_at: Date;
  updated_at: Date;
}

const columns =
  'id, slug, display_name, internal_reference, status, is_synthetic, created_at, updated_at';

export const toTenant = (row: TenantRow): TenantSummary => ({
  id: row.id,
  slug: row.slug,
  displayName: row.display_name,
  internalReference: row.internal_reference,
  status: row.status,
  isSynthetic: row.is_synthetic,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export async function listTenants(
  client: Queryable,
  filter: { status?: TenantStatus; q?: string; limit: number; offset: number },
): Promise<{ rows: TenantSummary[]; total: number }> {
  // Row-level security already limits rows to the caller's scope; the filter narrows further.
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.status) {
    values.push(filter.status);
    where.push(`status = $${values.length}`);
  }
  if (filter.q) {
    values.push(`%${filter.q.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(
      `(display_name ILIKE $${values.length} OR slug ILIKE $${values.length} OR internal_reference ILIKE $${values.length})`,
    );
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM issuer.tenant ${clause}`,
    values,
  );
  values.push(filter.limit, filter.offset);
  const result = await client.query<TenantRow>(
    `SELECT ${columns} FROM issuer.tenant ${clause}
      ORDER BY display_name LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return { rows: result.rows.map(toTenant), total: Number(total.rows[0]?.count ?? 0) };
}

export async function findTenant(
  client: Queryable,
  id: string,
  lock = false,
): Promise<TenantSummary | undefined> {
  const result = await client.query<TenantRow>(
    `SELECT ${columns} FROM issuer.tenant WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return result.rows[0] ? toTenant(result.rows[0]) : undefined;
}

export async function insertTenant(
  client: Queryable,
  tenant: { slug: string; displayName: string; internalReference: string; isSynthetic: boolean },
): Promise<TenantSummary> {
  const result = await client.query<TenantRow>(
    `INSERT INTO issuer.tenant (slug, display_name, internal_reference, status, is_synthetic)
     VALUES ($1, $2, $3, 'onboarding', $4) RETURNING ${columns}`,
    [tenant.slug, tenant.displayName, tenant.internalReference, tenant.isSynthetic],
  );
  return toTenant(result.rows[0]!);
}

export async function updateTenant(
  client: Queryable,
  id: string,
  changes: { displayName?: string; internalReference?: string; status?: TenantStatus },
): Promise<TenantSummary> {
  const result = await client.query<TenantRow>(
    `UPDATE issuer.tenant
        SET display_name = coalesce($2, display_name),
            internal_reference = coalesce($3, internal_reference),
            status = coalesce($4, status)
      WHERE id = $1 RETURNING ${columns}`,
    [id, changes.displayName ?? null, changes.internalReference ?? null, changes.status ?? null],
  );
  return toTenant(result.rows[0]!);
}

export async function currentConfiguration(
  client: Queryable,
  tenantId: string,
): Promise<TenantConfiguration | undefined> {
  const result = await client.query<{
    tenant_id: string;
    version: number;
    settings: unknown;
    created_at: Date;
    created_by: string;
  }>(
    `SELECT tenant_id, version, settings, created_at, created_by FROM issuer.tenant_configuration
      WHERE tenant_id = $1 ORDER BY version DESC LIMIT 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    tenantId: row.tenant_id,
    version: row.version,
    // Stored documents are re-validated on read; defaults fill fields added in later versions.
    settings: issuerSettingsSchema.parse(row.settings),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  };
}

export async function insertConfiguration(
  client: Queryable,
  tenantId: string,
  version: number,
  settings: IssuerSettings,
  createdBy: string,
): Promise<TenantConfiguration> {
  const result = await client.query<{ created_at: Date }>(
    `INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by)
     VALUES ($1, $2, $3, $4) RETURNING created_at`,
    [tenantId, version, JSON.stringify(settings), createdBy],
  );
  return {
    tenantId,
    version,
    settings,
    createdAt: result.rows[0]!.created_at.toISOString(),
    createdBy,
  };
}
