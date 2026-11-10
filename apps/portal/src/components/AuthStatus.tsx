import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../lib/session';
import { Icon } from './Icon';

/** Signed-in user, their context and sign-out. Tokens never reach the browser; only names do. */
export function AuthStatus() {
  const { session, signOut, state } = useSession();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (state.status !== 'authenticated' || !session) {
    return (
      <div className="text-xs text-ink-subtle" data-testid="auth-status">
        Not signed in
      </div>
    );
  }
  const { principal } = session;
  const initials = principal.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const context =
    principal.platformRoles.length > 0
      ? 'Platform'
      : principal.tenants.length > 0
        ? 'Issuer user'
        : 'No access';

  return (
    <div className="relative" ref={menu} data-testid="auth-status">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-hover"
      >
        <span className="hidden text-right xl:block">
          <span className="block text-xs font-medium text-ink" data-testid="signed-in-user">
            {principal.displayName}
          </span>
          <span className="block text-[11px] text-ink-subtle">
            {context}
            {session.mfa ? ' · 2-step verified' : ''}
          </span>
        </span>
        <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong ring-1 ring-accent/30">
          {initials}
        </span>
        <Icon name="chevron-down" className="size-4 text-ink-subtle" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-12 z-40 w-64 rounded-xl border border-line-strong bg-surface p-2 shadow-2xl"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="text-sm font-medium text-ink">{principal.displayName}</p>
            <p className="truncate text-xs text-ink-subtle">{principal.email}</p>
          </div>
          <Link
            role="menuitem"
            to="/account"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Icon name="account" className="size-4" /> Account and security
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
          >
            <Icon name="logout" className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
