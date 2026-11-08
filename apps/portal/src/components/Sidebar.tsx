import { NavLink } from 'react-router';
import type { Workspace } from '../app/navigation';
import { AtlasLogo } from './AtlasLogo';
import { Icon } from './Icon';

export function Sidebar({
  workspaces,
  onNavigate,
}: {
  workspaces: Workspace[];
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Main navigation" className="flex h-full flex-col">
      <NavLink
        to="/"
        onClick={onNavigate}
        className="flex h-16 items-center border-b border-line px-5"
      >
        <AtlasLogo />
      </NavLink>

      <div className="flex-1 space-y-7 overflow-y-auto px-3 py-6">
        {workspaces.map((workspace) => (
          <div key={workspace.id} role="group" aria-labelledby={`nav-${workspace.id}`}>
            <p
              id={`nav-${workspace.id}`}
              className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-subtle"
            >
              {workspace.label}
            </p>
            <ul className="space-y-0.5">
              {workspace.items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.path}
                    end
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? 'bg-accent-soft text-ink shadow-[inset_2px_0_0_0_var(--color-accent)]'
                          : 'text-ink-muted hover:bg-surface-hover hover:text-ink'
                      }`
                    }
                  >
                    <Icon
                      name={item.icon}
                      className="size-[18px] shrink-0 opacity-80 group-hover:opacity-100"
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.availability.status === 'planned' && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-subtle ring-1 ring-inset ring-line-strong">
                        S{item.availability.stage}
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-line px-5 py-4 text-[11px] leading-5 text-ink-subtle">
        <p className="flex items-center gap-1.5 font-medium text-ink-muted">
          <Icon name="shield" className="size-3.5" /> Non-production build
        </p>
        <p>Synthetic data only. Not PCI DSS assessed.</p>
      </div>
    </nav>
  );
}
