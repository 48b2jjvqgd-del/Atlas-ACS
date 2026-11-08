import { Icon } from './Icon';

/**
 * Authentication status area. Stage 0 has no sign-in: the area states that plainly. Stage 1A
 * connects it to OpenID Connect (Keycloak locally) and shows the user, tenant and roles.
 */
export function AuthStatus() {
  return (
    <div className="flex items-center gap-3" data-testid="auth-status">
      <div className="hidden text-right xl:block">
        <p className="text-xs font-medium text-ink">Not signed in</p>
        <p className="text-[11px] text-ink-subtle">Identity integration: Stage 1A</p>
      </div>
      <button
        type="button"
        disabled
        title="Sign-in is introduced in Stage 1A"
        className="inline-flex cursor-not-allowed items-center gap-2 whitespace-nowrap rounded-lg border border-line-strong bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink-subtle"
      >
        <Icon name="lock" className="size-3.5" />
        Sign in
      </button>
    </div>
  );
}
