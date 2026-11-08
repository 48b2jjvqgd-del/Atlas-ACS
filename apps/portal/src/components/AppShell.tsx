import { useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import {
  filterNavigation,
  findNavigationItem,
  stageZeroPermissionCheck,
  workspaces,
} from '../app/navigation';
import { AuthStatus } from './AuthStatus';
import { AtlasLogo } from './AtlasLogo';
import { EnvironmentBadge } from './EnvironmentBadge';
import { Icon } from './Icon';
import { Sidebar } from './Sidebar';

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const visible = filterNavigation(workspaces, stageZeroPermissionCheck);
  const current = findNavigationItem(location.pathname);

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[288px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">
        <Sidebar workspaces={visible} />
      </aside>

      {/* Tablet / narrow drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            type="button"
            className="absolute inset-0 bg-canvas/70 backdrop-blur-sm"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative h-full w-72 border-r border-line bg-surface">
            <Sidebar workspaces={visible} onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-8">
          <button
            type="button"
            className="rounded-lg p-2 text-ink-muted hover:bg-surface-hover hover:text-ink lg:hidden"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="lg:hidden">
            <AtlasLogo compact />
          </span>
          <p
            className="hidden min-w-0 truncate text-sm text-ink-subtle xl:block"
            aria-label="Breadcrumb"
          >
            {current ? (
              <>
                {current.workspace.label}
                <span className="mx-2 text-line-strong">/</span>
                <span className="text-ink">{current.item.label}</span>
              </>
            ) : (
              <span className="text-ink">Dashboard</span>
            )}
          </p>
          <div className="ml-auto flex items-center gap-4">
            <EnvironmentBadge />
            <span className="hidden h-6 w-px bg-line xl:block" aria-hidden="true" />
            <AuthStatus />
          </div>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-8 sm:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
