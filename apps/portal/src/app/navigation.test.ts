import { describe, expect, it } from 'vitest';
import { filterNavigation, findNavigationItem, workspaces } from './navigation';

describe('portal navigation', () => {
  it('provides every required platform and issuer entry', () => {
    const labels = Object.fromEntries(workspaces.map((w) => [w.id, w.items.map((i) => i.label)]));
    expect(labels.platform).toEqual([
      'Overview',
      'Issuers',
      'Services',
      'Integrations',
      'Users and permissions',
      'Audit',
      'System health',
    ]);
    expect(labels.issuer).toEqual([
      'Overview',
      'Authentication',
      'Fraud rules',
      'Challenges',
      'Compliance',
      'Reports',
      'Users',
      'Configuration',
    ]);
  });

  it('gives every item a unique path and a namespaced permission key', () => {
    const items = workspaces.flatMap((w) => w.items.map((item) => ({ workspace: w.id, item })));
    expect(new Set(items.map(({ item }) => item.path)).size).toBe(items.length);
    for (const { workspace, item } of items) {
      expect(item.permission).toMatch(new RegExp(`^${workspace}\\.[a-z-]+\\.read$`));
      expect(item.path.startsWith(`/${workspace}`)).toBe(true);
    }
  });

  it('marks unbuilt areas as planned with a future stage', () => {
    for (const item of workspaces.flatMap((w) => w.items)) {
      if (item.availability.status === 'planned')
        expect(item.availability.stage).toMatch(/^(1A|1B|[2-7])$/);
    }
  });

  it('filters items and drops workspaces the user cannot access', () => {
    const issuerAnalyst = new Set(['issuer.access', 'issuer.overview.read', 'issuer.reports.read']);
    const visible = filterNavigation(workspaces, (permission) => issuerAnalyst.has(permission));
    expect(visible.map((w) => w.id)).toEqual(['issuer']);
    expect(visible[0]?.items.map((i) => i.label)).toEqual(['Overview', 'Reports']);
  });

  it('drops a workspace whose items are all hidden even if the workspace itself is allowed', () => {
    expect(filterNavigation(workspaces, (permission) => permission === 'platform.access')).toEqual(
      [],
    );
  });

  it('resolves items by path', () => {
    expect(findNavigationItem('/platform/health')?.item.label).toBe('System health');
    expect(findNavigationItem('/nowhere')).toBeUndefined();
  });
});
