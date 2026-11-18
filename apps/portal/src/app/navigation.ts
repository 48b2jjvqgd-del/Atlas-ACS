import type { Permission } from '@atlas/contracts';

/**
 * Portal navigation model.
 *
 * Navigation is data, not markup, so it can be filtered by the signed-in user's permissions.
 * Platform items are checked against platform-wide permissions; issuer items against the
 * permissions the user holds in the active issuer. The backend remains the authority: hiding a
 * menu item is a usability feature, never an access control.
 */
export type WorkspaceId = 'platform' | 'issuer';

export type IconName =
  | 'overview'
  | 'issuers'
  | 'services'
  | 'integrations'
  | 'users'
  | 'audit'
  | 'health'
  | 'authentication'
  | 'rules'
  | 'challenges'
  | 'compliance'
  | 'reports'
  | 'configuration'
  | 'roles'
  | 'account';

/** Roadmap stage identifiers (docs/roadmap/ROADMAP.md). */
export type StageId = '1A' | '1B' | '2' | '3' | '4' | '5' | '6' | '7';

export type Availability =
  { status: 'live' } | { status: 'planned'; stage: StageId; summary: string };

export interface NavigationItem {
  id: string;
  label: string;
  path: string;
  icon: IconName;
  /** The item is shown when the user holds any of these permissions (in the workspace's scope). */
  permissions: readonly Permission[];
  availability: Availability;
}

export interface Workspace {
  id: WorkspaceId;
  label: string;
  description: string;
  basePath: string;
  /** platform: platform-wide permissions; tenant: permissions within the active issuer. */
  scope: 'platform' | 'tenant';
  items: NavigationItem[];
}

const planned = (stage: StageId, summary: string): Availability => ({
  status: 'planned',
  stage,
  summary,
});
const live: Availability = { status: 'live' };

export const workspaces: readonly Workspace[] = [
  {
    id: 'platform',
    label: 'Platform',
    description:
      'Operate ATLAS across all issuers: the issuer registry, users, roles, audit and system health.',
    basePath: '/platform',
    scope: 'platform',
    items: [
      {
        id: 'platform-overview',
        label: 'Overview',
        path: '/platform',
        icon: 'overview',
        permissions: ['issuer.read', 'platform.health.read', 'audit.read', 'platform.users.read'],
        availability: live,
      },
      {
        id: 'platform-issuers',
        label: 'Issuers',
        path: '/platform/issuers',
        icon: 'issuers',
        permissions: ['issuer.read'],
        availability: live,
      },
      {
        id: 'platform-users',
        label: 'Platform users',
        path: '/platform/users',
        icon: 'users',
        permissions: ['platform.users.read'],
        availability: live,
      },
      {
        id: 'platform-roles',
        label: 'Roles and permissions',
        path: '/platform/roles',
        icon: 'roles',
        permissions: ['platform.users.read', 'platform.roles.manage'],
        availability: live,
      },
      {
        id: 'platform-audit',
        label: 'Audit',
        path: '/platform/audit',
        icon: 'audit',
        permissions: ['audit.read'],
        availability: live,
      },
      {
        id: 'platform-integrations',
        label: 'Integrations',
        path: '/platform/integrations',
        icon: 'integrations',
        permissions: ['platform.integrations.read'],
        availability: planned(
          '1B',
          'Visa Secure and Mastercard Identity Check adapter configuration against the simulated directory servers.',
        ),
      },
      {
        id: 'platform-services',
        label: 'Services',
        path: '/platform/services',
        icon: 'services',
        permissions: ['platform.health.read'],
        availability: live,
      },
      {
        id: 'platform-health',
        label: 'System health',
        path: '/platform/health',
        icon: 'health',
        permissions: ['platform.health.read'],
        availability: live,
      },
    ],
  },
  {
    id: 'issuer',
    label: 'Issuer',
    description: 'Manage your issuer: profile and configuration, users and the audit trail.',
    basePath: '/issuer',
    scope: 'tenant',
    items: [
      {
        id: 'issuer-overview',
        label: 'Overview',
        path: '/issuer',
        icon: 'overview',
        permissions: ['issuer.read'],
        availability: live,
      },
      {
        id: 'issuer-configuration',
        label: 'Profile and configuration',
        path: '/issuer/configuration',
        icon: 'configuration',
        permissions: ['issuer.configuration.read'],
        availability: live,
      },
      {
        id: 'issuer-users',
        label: 'Users',
        path: '/issuer/users',
        icon: 'users',
        permissions: ['issuer.users.read'],
        availability: live,
      },
      {
        id: 'issuer-audit',
        label: 'Audit history',
        path: '/issuer/audit',
        icon: 'audit',
        permissions: ['audit.read'],
        availability: live,
      },
      {
        id: 'issuer-authentication',
        label: 'Authentication',
        path: '/issuer/authentication',
        icon: 'authentication',
        permissions: ['authentication.read'],
        availability: planned(
          '1B',
          'Authentication activity and frictionless / challenge / decline outcomes for this issuer.',
        ),
      },
      {
        id: 'issuer-fraud-rules',
        label: 'Fraud rules',
        path: '/issuer/fraud-rules',
        icon: 'rules',
        permissions: ['fraud.rules.read'],
        availability: planned(
          '2',
          'Issuer-configurable risk rules with versioning, simulation and approval.',
        ),
      },
      {
        id: 'issuer-challenges',
        label: 'Challenges',
        path: '/issuer/challenges',
        icon: 'challenges',
        permissions: ['issuer.configuration.read'],
        availability: planned(
          '3',
          'Challenge methods (OTP, out-of-band, biometrics) and their configuration.',
        ),
      },
      {
        id: 'issuer-compliance',
        label: 'Compliance',
        path: '/issuer/compliance',
        icon: 'compliance',
        permissions: ['compliance.read'],
        availability: planned('4', 'SCA exemption policy and regulatory compliance reporting.'),
      },
      {
        id: 'issuer-reports',
        label: 'Reports',
        path: '/issuer/reports',
        icon: 'reports',
        permissions: ['reports.read'],
        availability: planned('5', 'Tenant-scoped operational and authentication reports.'),
      },
    ],
  },
];

/** Answers whether the user holds a permission in the given scope (active issuer for tenant). */
export type PermissionCheck = (permission: Permission, scope: 'platform' | 'tenant') => boolean;

/** Returns only the workspaces and items the user may see. Workspaces with no visible items are dropped. */
export function filterNavigation(source: readonly Workspace[], can: PermissionCheck): Workspace[] {
  return source
    .map((workspace) => ({
      ...workspace,
      items: workspace.items.filter((item) =>
        item.permissions.some((permission) => can(permission, workspace.scope)),
      ),
    }))
    .filter((workspace) => workspace.items.length > 0);
}

export function findNavigationItem(
  path: string,
): { workspace: Workspace; item: NavigationItem } | undefined {
  let best: { workspace: Workspace; item: NavigationItem } | undefined;
  for (const workspace of workspaces) {
    for (const item of workspace.items) {
      if (
        path === item.path ||
        (item.path !== workspace.basePath && path.startsWith(`${item.path}/`))
      ) {
        if (!best || item.path.length > best.item.path.length) best = { workspace, item };
      }
    }
  }
  return best;
}
