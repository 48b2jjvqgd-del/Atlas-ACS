/**
 * Portal navigation model.
 *
 * Navigation is data, not markup, so it can be filtered by the signed-in user's permissions.
 * Every item declares the permission that will be required to see it. In Stage 0 no permissions
 * are enforced (there is no sign-in yet); see filterNavigation(). The backend remains the
 * authority: hiding a menu item is a usability feature, never an access control.
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
  | 'configuration';

/** Roadmap stage identifiers (docs/roadmap/ROADMAP.md). */
export type StageId = '1A' | '1B' | '2' | '3' | '4' | '5' | '6' | '7';

export type Availability =
  { status: 'live' } | { status: 'planned'; stage: StageId; summary: string };

export interface NavigationItem {
  id: string;
  label: string;
  path: string;
  icon: IconName;
  /** Permission key required to see this item, e.g. "platform.issuers.read". */
  permission: string;
  availability: Availability;
}

export interface Workspace {
  id: WorkspaceId;
  label: string;
  description: string;
  basePath: string;
  permission: string;
  items: NavigationItem[];
}

const planned = (stage: StageId, summary: string): Availability => ({
  status: 'planned',
  stage,
  summary,
});

export const workspaces: readonly Workspace[] = [
  {
    id: 'platform',
    label: 'Platform',
    description: 'Operate ATLAS across all issuers: tenants, services, integrations and oversight.',
    basePath: '/platform',
    permission: 'platform.access',
    items: [
      {
        id: 'platform-overview',
        label: 'Overview',
        path: '/platform',
        icon: 'overview',
        permission: 'platform.overview.read',
        availability: { status: 'live' },
      },
      {
        id: 'platform-issuers',
        label: 'Issuers',
        path: '/platform/issuers',
        icon: 'issuers',
        permission: 'platform.issuers.read',
        availability: planned(
          '1A',
          'Issuer (tenant) registry, onboarding and lifecycle management.',
        ),
      },
      {
        id: 'platform-services',
        label: 'Services',
        path: '/platform/services',
        icon: 'services',
        permission: 'platform.services.read',
        availability: { status: 'live' },
      },
      {
        id: 'platform-integrations',
        label: 'Integrations',
        path: '/platform/integrations',
        icon: 'integrations',
        permission: 'platform.integrations.read',
        availability: planned(
          '1B',
          'Visa Secure and Mastercard Identity Check adapter configuration against the simulated directory servers.',
        ),
      },
      {
        id: 'platform-users',
        label: 'Users and permissions',
        path: '/platform/users',
        icon: 'users',
        permission: 'platform.users.read',
        availability: planned(
          '1A',
          'Platform users, roles and granular permissions, backed by the identity service and OpenID Connect.',
        ),
      },
      {
        id: 'platform-audit',
        label: 'Audit',
        path: '/platform/audit',
        icon: 'audit',
        permission: 'platform.audit.read',
        availability: planned(
          '5',
          'Searchable, tamper-evident audit trail of configuration changes and decisions.',
        ),
      },
      {
        id: 'platform-health',
        label: 'System health',
        path: '/platform/health',
        icon: 'health',
        permission: 'platform.health.read',
        availability: { status: 'live' },
      },
    ],
  },
  {
    id: 'issuer',
    label: 'Issuer',
    description: 'Manage one issuer: authentication policy, risk rules, challenges and reporting.',
    basePath: '/issuer',
    permission: 'issuer.access',
    items: [
      {
        id: 'issuer-overview',
        label: 'Overview',
        path: '/issuer',
        icon: 'overview',
        permission: 'issuer.overview.read',
        availability: { status: 'live' },
      },
      {
        id: 'issuer-authentication',
        label: 'Authentication',
        path: '/issuer/authentication',
        icon: 'authentication',
        permission: 'issuer.authentication.read',
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
        permission: 'issuer.fraud-rules.read',
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
        permission: 'issuer.challenges.read',
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
        permission: 'issuer.compliance.read',
        availability: planned('4', 'SCA exemption policy and regulatory compliance reporting.'),
      },
      {
        id: 'issuer-reports',
        label: 'Reports',
        path: '/issuer/reports',
        icon: 'reports',
        permission: 'issuer.reports.read',
        availability: planned('5', 'Tenant-scoped operational and authentication reports.'),
      },
      {
        id: 'issuer-users',
        label: 'Users',
        path: '/issuer/users',
        icon: 'users',
        permission: 'issuer.users.read',
        availability: planned('1A', 'Issuer users and their roles within this tenant.'),
      },
      {
        id: 'issuer-configuration',
        label: 'Configuration',
        path: '/issuer/configuration',
        icon: 'configuration',
        permission: 'issuer.configuration.read',
        availability: planned(
          '1A',
          'Issuer profile, BIN ranges, scheme participation and branding.',
        ),
      },
    ],
  },
];

export type PermissionCheck = (permission: string) => boolean;

/** Returns only the workspaces and items the user may see. Workspaces with no visible items are dropped. */
export function filterNavigation(source: readonly Workspace[], can: PermissionCheck): Workspace[] {
  return source
    .filter((workspace) => can(workspace.permission))
    .map((workspace) => ({
      ...workspace,
      items: workspace.items.filter((item) => can(item.permission)),
    }))
    .filter((workspace) => workspace.items.length > 0);
}

/**
 * Stage 0 has no authenticated user, so every item is shown and each page states its status.
 * Stage 1A replaces this with the permission set issued by the identity service.
 */
export const stageZeroPermissionCheck: PermissionCheck = () => true;

export function findNavigationItem(
  path: string,
): { workspace: Workspace; item: NavigationItem } | undefined {
  for (const workspace of workspaces) {
    const item = workspace.items.find((candidate) => candidate.path === path);
    if (item) return { workspace, item };
  }
  return undefined;
}
