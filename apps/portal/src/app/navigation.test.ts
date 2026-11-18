import { isPermission, systemRoles, type Permission, type SystemRoleKey } from '@atlas/contracts';
import { describe, expect, it } from 'vitest';
import { filterNavigation, findNavigationItem, workspaces } from './navigation';

/** The navigation a holder of exactly these system roles would see. */
function visibleFor(platformRoles: SystemRoleKey[], tenantRoles: SystemRoleKey[]) {
  const platform = new Set<Permission>(
    platformRoles.flatMap((role) => systemRoles[role].permissions),
  );
  const tenant = new Set<Permission>(tenantRoles.flatMap((role) => systemRoles[role].permissions));
  const visible = filterNavigation(workspaces, (permission, scope) =>
    scope === 'platform'
      ? platform.has(permission)
      : platform.has(permission) || tenant.has(permission),
  );
  return Object.fromEntries(visible.map((w) => [w.id, w.items.map((i) => i.label)]));
}

describe('portal navigation', () => {
  it('provides every platform and issuer entry', () => {
    const labels = Object.fromEntries(workspaces.map((w) => [w.id, w.items.map((i) => i.label)]));
    expect(labels.platform).toEqual([
      'Overview',
      'Issuers',
      'Platform users',
      'Roles and permissions',
      'Audit',
      'Integrations',
      'Services',
      'System health',
    ]);
    expect(labels.issuer).toEqual([
      'Overview',
      'Profile and configuration',
      'Users',
      'Audit history',
      'Authentication',
      'Fraud rules',
      'Challenges',
      'Compliance',
      'Reports',
    ]);
  });

  it('gives every item a unique path and only catalogued permissions', () => {
    const items = workspaces.flatMap((w) => w.items.map((item) => ({ workspace: w.id, item })));
    expect(new Set(items.map(({ item }) => item.path)).size).toBe(items.length);
    for (const { workspace, item } of items) {
      expect(item.permissions.length).toBeGreaterThan(0);
      for (const permission of item.permissions) expect(isPermission(permission)).toBe(true);
      expect(item.path.startsWith(`/${workspace}`)).toBe(true);
    }
  });

  it('marks unbuilt areas as planned with a future stage, and 1A areas as live', () => {
    for (const item of workspaces.flatMap((w) => w.items)) {
      if (item.availability.status === 'planned')
        expect(item.availability.stage).toMatch(/^(1B|[2-7])$/);
    }
  });

  it('shows a Platform Super Admin the whole platform workspace and no issuer workspace without membership', () => {
    const visible = visibleFor(['platform-super-admin'], []);
    expect(visible.platform).toHaveLength(8);
    expect(visible.issuer).toHaveLength(9);
  });

  it('never shows an issuer administrator the platform workspace', () => {
    const visible = visibleFor([], ['issuer-administrator']);
    expect(visible.platform).toBeUndefined();
    expect(visible.issuer).toEqual([
      'Overview',
      'Profile and configuration',
      'Users',
      'Audit history',
      'Authentication',
      'Fraud rules',
      'Challenges',
      'Compliance',
      'Reports',
    ]);
  });

  it('gives Customer Support no configuration, user, fraud-rule or compliance areas', () => {
    expect(visibleFor([], ['customer-support'])).toEqual({
      issuer: ['Overview', 'Authentication'],
    });
  });

  it('gives a Reporting User reports, not configuration', () => {
    expect(visibleFor([], ['reporting-user'])).toEqual({ issuer: ['Overview', 'Reports'] });
  });

  it('gives a Technical Administrator health and audit but not user administration', () => {
    const visible = visibleFor(['technical-administrator'], []);
    expect(visible.platform).toEqual([
      'Overview',
      'Issuers',
      'Audit',
      'Integrations',
      'Services',
      'System health',
    ]);
  });

  it('drops workspaces with no visible items', () => {
    expect(filterNavigation(workspaces, () => false)).toEqual([]);
  });

  it('resolves items by path, including detail pages', () => {
    expect(findNavigationItem('/platform/health')?.item.label).toBe('System health');
    expect(findNavigationItem('/platform/issuers/abc')?.item.label).toBe('Issuers');
    expect(findNavigationItem('/issuer')?.item.label).toBe('Overview');
    expect(findNavigationItem('/nowhere')).toBeUndefined();
  });
});
