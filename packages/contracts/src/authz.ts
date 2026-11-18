import { z } from '@atlas/schemas';

/**
 * Authorisation model — granular permissions grouped into roles.
 *
 * - A **permission** is a stable key such as `issuer.users.manage`. Every API route declares the
 *   permission it requires; there is no check on role names anywhere in the backend.
 * - A **role** is a named set of permissions with a scope:
 *     platform — assigned to a user platform-wide; its permissions apply to every issuer.
 *     tenant   — assigned to a user *within one issuer*; its permissions apply to that issuer only.
 * - Some permissions are **platform-only** (e.g. `issuer.create`): they can never be placed in a
 *   tenant role, so an issuer user can never obtain platform administration rights.
 *
 * The catalogue below is the source of truth for permission keys and the built-in (system) roles.
 * identity-service seeds them into its schema by migration and treats system roles as read-only;
 * additional custom roles can be created at runtime from these permissions. Adding a permission is
 * additive and backwards-compatible; renaming or removing one is a breaking change.
 */
export const permissionScopes = ['platform', 'tenant'] as const;
export type PermissionScope = (typeof permissionScopes)[number];

interface PermissionDefinition {
  description: string;
  /** Scopes at which a role may grant this permission. */
  scopes: readonly PermissionScope[];
  /** Grouping for display. */
  category: string;
}

const both = ['platform', 'tenant'] as const;
const platformOnly = ['platform'] as const;

export const permissionCatalog = {
  // Issuer registry and administration
  'issuer.create': {
    description: 'Register a new issuer on the platform',
    scopes: platformOnly,
    category: 'Issuers',
  },
  'issuer.read': {
    description: 'View issuer profile and status',
    scopes: both,
    category: 'Issuers',
  },
  'issuer.update': {
    description: 'Edit issuer profile details',
    scopes: platformOnly,
    category: 'Issuers',
  },
  'issuer.status.manage': {
    description: 'Activate, suspend or offboard an issuer',
    scopes: platformOnly,
    category: 'Issuers',
  },
  'issuer.configuration.read': {
    description: 'View issuer configuration',
    scopes: both,
    category: 'Issuers',
  },
  'issuer.configuration.manage': {
    description: 'Change issuer configuration',
    scopes: both,
    category: 'Issuers',
  },
  'issuer.users.read': {
    description: 'View users of an issuer and their roles',
    scopes: both,
    category: 'Issuer users',
  },
  'issuer.users.manage': {
    description: 'Invite issuer users, assign issuer roles and disable access',
    scopes: both,
    category: 'Issuer users',
  },
  // Authentication activity (Stage 1B onwards)
  'authentication.read': {
    description: 'View authentication activity and outcomes',
    scopes: both,
    category: 'Authentication',
  },
  // Fraud and decisioning (Stage 2)
  'fraud.rules.read': {
    description: 'View fraud and risk rules',
    scopes: both,
    category: 'Fraud',
  },
  'fraud.rules.manage': {
    description: 'Create, change and approve fraud and risk rules',
    scopes: both,
    category: 'Fraud',
  },
  // Compliance (Stage 4)
  'compliance.read': {
    description: 'View compliance policy and evidence',
    scopes: both,
    category: 'Compliance',
  },
  'compliance.manage': {
    description: 'Change compliance and exemption policy',
    scopes: both,
    category: 'Compliance',
  },
  // Reporting (Stage 5)
  'reports.read': { description: 'View reports', scopes: both, category: 'Reports' },
  'reports.export': { description: 'Export reports', scopes: both, category: 'Reports' },
  // Audit
  'audit.read': { description: 'View the audit trail', scopes: both, category: 'Audit' },
  'audit.verify': {
    description: 'Verify audit-trail hash chains',
    scopes: platformOnly,
    category: 'Audit',
  },
  // Platform administration
  'platform.users.read': {
    description: 'View platform users and their roles',
    scopes: platformOnly,
    category: 'Platform',
  },
  'platform.users.manage': {
    description: 'Invite platform users, assign platform roles and disable access',
    scopes: platformOnly,
    category: 'Platform',
  },
  'platform.roles.manage': {
    description: 'Create and change custom roles and their permissions',
    scopes: platformOnly,
    category: 'Platform',
  },
  'platform.health.read': {
    description: 'View service health and platform status',
    scopes: platformOnly,
    category: 'Platform',
  },
  'platform.integrations.read': {
    description: 'View scheme integration configuration',
    scopes: platformOnly,
    category: 'Platform',
  },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof permissionCatalog;
export const permissionKeys = Object.keys(permissionCatalog) as [Permission, ...Permission[]];
export const permissionSchema = z.enum(permissionKeys);

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(permissionCatalog, value);
}

export function permissionAllowsScope(permission: Permission, scope: PermissionScope): boolean {
  return (permissionCatalog[permission].scopes as readonly PermissionScope[]).includes(scope);
}

interface SystemRoleDefinition {
  name: string;
  description: string;
  scope: PermissionScope;
  permissions: readonly Permission[];
}

const allPlatformPermissions = permissionKeys.filter((key) =>
  permissionAllowsScope(key, 'platform'),
);

/** Built-in roles. Keys are stable identifiers; names are for display. */
export const systemRoles = {
  // ---- Platform roles
  'platform-super-admin': {
    name: 'Platform Super Admin',
    description: 'Full control of the platform, including platform users and role definitions.',
    scope: 'platform',
    permissions: allPlatformPermissions,
  },
  'platform-administrator': {
    name: 'Platform Administrator',
    description: 'Operates the issuer registry and issuer users across all issuers.',
    scope: 'platform',
    permissions: [
      'issuer.create',
      'issuer.read',
      'issuer.update',
      'issuer.status.manage',
      'issuer.configuration.read',
      'issuer.configuration.manage',
      'issuer.users.read',
      'issuer.users.manage',
      'audit.read',
      'platform.users.read',
      'platform.health.read',
      'platform.integrations.read',
    ],
  },
  'technical-administrator': {
    name: 'Technical Administrator',
    description: 'Monitors platform health and integrations; read-only on issuers.',
    scope: 'platform',
    permissions: [
      'issuer.read',
      'issuer.configuration.read',
      'audit.read',
      'audit.verify',
      'platform.health.read',
      'platform.integrations.read',
    ],
  },
  // ---- Issuer (tenant) roles
  'issuer-administrator': {
    name: 'Issuer Administrator',
    description: 'Administers one issuer: configuration and issuer users.',
    scope: 'tenant',
    permissions: [
      'issuer.read',
      'issuer.configuration.read',
      'issuer.configuration.manage',
      'issuer.users.read',
      'issuer.users.manage',
      'authentication.read',
      'fraud.rules.read',
      'compliance.read',
      'reports.read',
      'audit.read',
    ],
  },
  'fraud-manager': {
    name: 'Fraud Manager',
    description: 'Owns fraud and risk rules for the issuer.',
    scope: 'tenant',
    permissions: [
      'issuer.read',
      'authentication.read',
      'fraud.rules.read',
      'fraud.rules.manage',
      'reports.read',
    ],
  },
  'fraud-analyst': {
    name: 'Fraud Analyst',
    description: 'Investigates authentication activity; read-only on rules.',
    scope: 'tenant',
    permissions: ['issuer.read', 'authentication.read', 'fraud.rules.read'],
  },
  'compliance-officer': {
    name: 'Compliance Officer',
    description: 'Owns compliance and exemption policy; reviews the audit trail.',
    scope: 'tenant',
    permissions: [
      'issuer.read',
      'compliance.read',
      'compliance.manage',
      'reports.read',
      'audit.read',
    ],
  },
  'operations-manager': {
    name: 'Operations Manager',
    description: 'Oversees day-to-day operations and reporting.',
    scope: 'tenant',
    permissions: [
      'issuer.read',
      'issuer.configuration.read',
      'issuer.users.read',
      'authentication.read',
      'reports.read',
      'reports.export',
    ],
  },
  'customer-support': {
    name: 'Customer Support',
    description:
      'Looks up authentication activity to help cardholders. Cannot change configuration.',
    scope: 'tenant',
    permissions: ['issuer.read', 'authentication.read'],
  },
  'reporting-user': {
    name: 'Reporting User',
    description: 'Views and exports reports only.',
    scope: 'tenant',
    permissions: ['issuer.read', 'reports.read', 'reports.export'],
  },
} as const satisfies Record<string, SystemRoleDefinition>;

export type SystemRoleKey = keyof typeof systemRoles;
export const systemRoleKeys = Object.keys(systemRoles) as [SystemRoleKey, ...SystemRoleKey[]];

/** Role keys: lowercase kebab-case, 2–63 characters. */
export const roleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Role key must be lowercase kebab-case')
  .min(2)
  .max(63);

/**
 * The authorisation view of an authenticated user, as resolved by identity-service from
 * server-side associations (never from client input or from roles in the IdP token).
 */
export const principalSchema = z.object({
  userId: z.uuid(),
  subject: z.string().min(1).max(255),
  email: z.email(),
  displayName: z.string().min(1).max(200),
  status: z.enum(['active', 'disabled', 'invited']),
  /** Permissions that apply to every issuer. */
  platformPermissions: z.array(permissionSchema),
  /** Per-issuer permissions, from the user's issuer memberships. */
  tenants: z.array(
    z.object({
      tenantId: z.uuid(),
      roles: z.array(roleKeySchema),
      permissions: z.array(permissionSchema),
    }),
  ),
  platformRoles: z.array(roleKeySchema),
});

export type Principal = z.infer<typeof principalSchema>;

/**
 * Evaluates permissions for a principal.
 *
 * - `can(p)` — platform-wide permission (applies to every tenant).
 * - `can(p, tenantId)` — permission within one tenant: platform-wide, or via membership.
 * - `tenantIds(p)` — tenants on which the permission holds; `'all'` when held platform-wide.
 */
export function authorizer(principal: Principal) {
  const platform = new Set<string>(principal.platformPermissions);
  const tenants = new Map(
    principal.tenants.map((t) => [t.tenantId, new Set<string>(t.permissions)]),
  );
  return {
    can(permission: Permission, tenantId?: string): boolean {
      if (principal.status !== 'active') return false;
      if (platform.has(permission)) return true;
      return tenantId !== undefined && (tenants.get(tenantId)?.has(permission) ?? false);
    },
    tenantIds(permission: Permission): 'all' | string[] {
      if (principal.status !== 'active') return [];
      if (platform.has(permission)) return 'all';
      return [...tenants].filter(([, set]) => set.has(permission)).map(([id]) => id);
    },
    /** True when the user holds the permission anywhere (platform or any tenant). */
    canAnywhere(permission: Permission): boolean {
      if (principal.status !== 'active') return false;
      return platform.has(permission) || [...tenants.values()].some((set) => set.has(permission));
    },
    isPlatformUser: principal.platformPermissions.length > 0,
  };
}

export type Authorizer = ReturnType<typeof authorizer>;
