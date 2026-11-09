import {
  isPermission,
  permissionAllowsScope,
  systemRoles,
  type Permission,
  type PermissionScope,
  type PlatformUser,
  type Principal,
  type Role,
  type TenantUser,
  type UserSummary,
} from '@atlas/contracts';
import type { Queryable } from '@atlas/service-kit';

/**
 * identity schema access. Every function takes a client already inside a scoped transaction
 * (inScope), so row-level security applies to tenant memberships.
 */
interface UserRow {
  id: string;
  idp_subject: string | null;
  email: string;
  display_name: string;
  status: 'invited' | 'active' | 'disabled';
  is_synthetic: boolean;
  last_sign_in_at: Date | null;
  created_at: Date;
}

const userColumns =
  'u.id, u.idp_subject, u.email, u.display_name, u.status, u.is_synthetic, u.last_sign_in_at, u.created_at';

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    isSynthetic: row.is_synthetic,
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

const validPermissions = (values: readonly string[]): Permission[] =>
  values.filter((value): value is Permission => isPermission(value));

// ---------------------------------------------------------------- roles

interface RoleRow {
  key: string;
  scope: PermissionScope;
  name: string;
  description: string;
  is_system: boolean;
  permissions: string[];
}

const toRole = (row: RoleRow): Role => ({
  key: row.key,
  scope: row.scope,
  name: row.name,
  description: row.description,
  isSystem: row.is_system,
  // A permission dropped from the catalogue is ignored rather than granted.
  permissions: validPermissions(row.permissions).filter((p) => permissionAllowsScope(p, row.scope)),
});

export async function listRoles(client: Queryable): Promise<Role[]> {
  const result = await client.query<RoleRow>(
    'SELECT key, scope, name, description, is_system, permissions FROM identity.role ORDER BY scope, is_system DESC, name',
  );
  return result.rows.map(toRole);
}

export async function findRole(client: Queryable, key: string): Promise<Role | undefined> {
  const result = await client.query<RoleRow>(
    'SELECT key, scope, name, description, is_system, permissions FROM identity.role WHERE key = $1',
    [key],
  );
  return result.rows[0] ? toRole(result.rows[0]) : undefined;
}

export async function insertRole(client: Queryable, role: Omit<Role, 'isSystem'>): Promise<void> {
  await client.query(
    `INSERT INTO identity.role (key, scope, name, description, is_system, permissions)
     VALUES ($1, $2, $3, $4, false, $5)`,
    [role.key, role.scope, role.name, role.description, role.permissions],
  );
}

export async function updateRole(
  client: Queryable,
  key: string,
  changes: { name: string; description: string; permissions: readonly Permission[] },
): Promise<void> {
  await client.query(
    'UPDATE identity.role SET name = $2, description = $3, permissions = $4 WHERE key = $1 AND NOT is_system',
    [key, changes.name, changes.description, changes.permissions],
  );
}

/**
 * Brings system roles in line with the contracts catalogue. Returns the roles that changed, so
 * the change can be audited.
 */
export async function synchroniseSystemRoles(
  client: Queryable,
): Promise<{ key: string; before: string[]; after: string[] }[]> {
  const changed: { key: string; before: string[]; after: string[] }[] = [];
  for (const [key, definition] of Object.entries(systemRoles)) {
    const existing = await client.query<{
      permissions: string[];
      name: string;
      description: string;
    }>(
      'SELECT permissions, name, description FROM identity.role WHERE key = $1 AND is_system FOR UPDATE',
      [key],
    );
    const desired = [...definition.permissions].sort();
    const current = existing.rows[0];
    if (!current) {
      await client.query(
        `INSERT INTO identity.role (key, scope, name, description, is_system, permissions)
         VALUES ($1, $2, $3, $4, true, $5)`,
        [key, definition.scope, definition.name, definition.description, desired],
      );
      changed.push({ key, before: [], after: desired });
      continue;
    }
    const before = [...current.permissions].sort();
    if (
      before.join(',') !== desired.join(',') ||
      current.name !== definition.name ||
      current.description !== definition.description
    ) {
      await client.query(
        'UPDATE identity.role SET permissions = $2, name = $3, description = $4 WHERE key = $1',
        [key, desired, definition.name, definition.description],
      );
      if (before.join(',') !== desired.join(',')) changed.push({ key, before, after: desired });
    }
  }
  return changed;
}

// ---------------------------------------------------------------- principals

export async function resolvePrincipal(
  client: Queryable,
  subject: string,
): Promise<Principal | null> {
  const user = await client.query<UserRow>(
    `SELECT ${userColumns} FROM identity.user_account u WHERE u.idp_subject = $1`,
    [subject],
  );
  const row = user.rows[0];
  if (!row) return null;
  return principalForUser(client, row);
}

async function principalForUser(client: Queryable, row: UserRow): Promise<Principal> {
  const platform = await client.query<{ role_key: string; permissions: string[] }>(
    `SELECT a.role_key, r.permissions FROM identity.platform_role_assignment a
       JOIN identity.role r ON r.key = a.role_key
      WHERE a.user_id = $1 ORDER BY a.role_key`,
    [row.id],
  );
  const tenant = await client.query<{ tenant_id: string; role_key: string; permissions: string[] }>(
    `SELECT a.tenant_id, a.role_key, r.permissions FROM identity.tenant_role_assignment a
       JOIN identity.role r ON r.key = a.role_key
      WHERE a.user_id = $1 ORDER BY a.tenant_id, a.role_key`,
    [row.id],
  );
  const platformPermissions = new Set<Permission>();
  for (const assignment of platform.rows) {
    for (const p of validPermissions(assignment.permissions)) {
      if (permissionAllowsScope(p, 'platform')) platformPermissions.add(p);
    }
  }
  const tenants = new Map<string, { roles: string[]; permissions: Set<Permission> }>();
  for (const assignment of tenant.rows) {
    const entry = tenants.get(assignment.tenant_id) ?? { roles: [], permissions: new Set() };
    entry.roles.push(assignment.role_key);
    for (const p of validPermissions(assignment.permissions)) {
      if (permissionAllowsScope(p, 'tenant')) entry.permissions.add(p);
    }
    tenants.set(assignment.tenant_id, entry);
  }
  return {
    userId: row.id,
    subject: row.idp_subject ?? '',
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    platformRoles: platform.rows.map((r) => r.role_key),
    platformPermissions: [...platformPermissions].sort(),
    tenants: [...tenants].map(([tenantId, entry]) => ({
      tenantId,
      roles: entry.roles,
      permissions: [...entry.permissions].sort(),
    })),
  };
}

export async function recordSignIn(client: Queryable, subject: string): Promise<void> {
  await client.query(
    `UPDATE identity.user_account
        SET last_sign_in_at = now(), status = CASE WHEN status = 'invited' THEN 'active' ELSE status END
      WHERE idp_subject = $1`,
    [subject],
  );
}

// ---------------------------------------------------------------- users

export async function findUser(client: Queryable, id: string): Promise<UserRow | undefined> {
  const result = await client.query<UserRow>(
    `SELECT ${userColumns} FROM identity.user_account u WHERE u.id = $1`,
    [id],
  );
  return result.rows[0];
}

export async function findUserByEmail(
  client: Queryable,
  email: string,
): Promise<UserRow | undefined> {
  const result = await client.query<UserRow>(
    `SELECT ${userColumns} FROM identity.user_account u WHERE u.email = $1`,
    [email],
  );
  return result.rows[0];
}

export async function insertUser(
  client: Queryable,
  user: { email: string; displayName: string; subject: string | null; isSynthetic: boolean },
): Promise<UserRow> {
  const result = await client.query<UserRow>(
    `INSERT INTO identity.user_account AS u (email, display_name, idp_subject, status, is_synthetic)
     VALUES ($1, $2, $3, 'invited', $4)
     RETURNING ${userColumns}`,
    [user.email, user.displayName, user.subject, user.isSynthetic],
  );
  return result.rows[0]!;
}

export async function setUserStatus(
  client: Queryable,
  id: string,
  status: 'active' | 'disabled',
): Promise<void> {
  await client.query('UPDATE identity.user_account SET status = $2 WHERE id = $1', [id, status]);
}

export async function listPlatformUsers(client: Queryable): Promise<PlatformUser[]> {
  const result = await client.query<UserRow & { roles: string[] }>(
    `SELECT ${userColumns}, array_agg(a.role_key ORDER BY a.role_key) AS roles
       FROM identity.user_account u
       JOIN identity.platform_role_assignment a ON a.user_id = u.id
      GROUP BY u.id
      ORDER BY u.display_name`,
  );
  return result.rows.map((row) => ({ ...toUserSummary(row), roles: row.roles }));
}

export async function platformRolesOf(client: Queryable, userId: string): Promise<string[]> {
  const result = await client.query<{ role_key: string }>(
    'SELECT role_key FROM identity.platform_role_assignment WHERE user_id = $1 ORDER BY role_key',
    [userId],
  );
  return result.rows.map((row) => row.role_key);
}

export async function replacePlatformRoles(
  client: Queryable,
  userId: string,
  roles: readonly string[],
  grantedBy: string,
): Promise<void> {
  await client.query('DELETE FROM identity.platform_role_assignment WHERE user_id = $1', [userId]);
  for (const role of roles) {
    await client.query(
      'INSERT INTO identity.platform_role_assignment (user_id, role_key, granted_by) VALUES ($1, $2, $3)',
      [userId, role, grantedBy],
    );
  }
}

export async function countActiveSuperAdmins(
  client: Queryable,
  excluding?: string,
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM identity.platform_role_assignment a
       JOIN identity.user_account u ON u.id = a.user_id
      WHERE a.role_key = 'platform-super-admin' AND u.status = 'active'
        AND ($1::uuid IS NULL OR u.id <> $1::uuid)`,
    [excluding ?? null],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function listTenantUsers(client: Queryable, tenantId: string): Promise<TenantUser[]> {
  const result = await client.query<UserRow & { roles: string[]; tenant_id: string }>(
    `SELECT ${userColumns}, a.tenant_id, array_agg(a.role_key ORDER BY a.role_key) AS roles
       FROM identity.tenant_role_assignment a
       JOIN identity.user_account u ON u.id = a.user_id
      WHERE a.tenant_id = $1
      GROUP BY u.id, a.tenant_id
      ORDER BY u.display_name`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    ...toUserSummary(row),
    tenantId: row.tenant_id,
    roles: row.roles,
  }));
}

export async function tenantRolesOf(
  client: Queryable,
  userId: string,
  tenantId: string,
): Promise<string[]> {
  const result = await client.query<{ role_key: string }>(
    'SELECT role_key FROM identity.tenant_role_assignment WHERE user_id = $1 AND tenant_id = $2 ORDER BY role_key',
    [userId, tenantId],
  );
  return result.rows.map((row) => row.role_key);
}

export async function replaceTenantRoles(
  client: Queryable,
  userId: string,
  tenantId: string,
  roles: readonly string[],
  grantedBy: string,
): Promise<void> {
  await client.query(
    'DELETE FROM identity.tenant_role_assignment WHERE user_id = $1 AND tenant_id = $2',
    [userId, tenantId],
  );
  for (const role of roles) {
    await client.query(
      `INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by)
       VALUES ($1, $2, $3, $4)`,
      [userId, tenantId, role, grantedBy],
    );
  }
}

/** Tenants a user belongs to (any role), for authorisation of user-level actions. */
export async function tenantsOf(client: Queryable, userId: string): Promise<string[]> {
  const result = await client.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM identity.tenant_role_assignment WHERE user_id = $1',
    [userId],
  );
  return result.rows.map((row) => row.tenant_id);
}

// ---------------------------------------------------------------- IdP event cursor

export async function readEventCursor(client: Queryable): Promise<number> {
  const result = await client.query<{ last_event_time: string }>(
    'SELECT last_event_time::text FROM identity.idp_event_cursor WHERE id = 1',
  );
  return Number(result.rows[0]?.last_event_time ?? 0);
}

export async function writeEventCursor(client: Queryable, value: number): Promise<void> {
  await client.query(
    `INSERT INTO identity.idp_event_cursor (id, last_event_time) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET last_event_time = EXCLUDED.last_event_time`,
    [value],
  );
}
