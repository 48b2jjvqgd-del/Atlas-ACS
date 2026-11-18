import { useTenant } from '../lib/tenant';

/** Shown in the issuer workspace when the user belongs to more than one issuer. */
export function TenantSwitcher() {
  const { memberships, activeTenantId, setActiveTenantId, names } = useTenant();
  if (memberships.length === 0) return null;
  if (memberships.length === 1) {
    return (
      <span
        className="hidden rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted sm:inline"
        data-testid="active-issuer"
      >
        {names[memberships[0]!.tenantId] ?? 'Issuer'}
      </span>
    );
  }
  return (
    <label className="hidden items-center gap-2 text-xs text-ink-subtle sm:flex">
      Issuer
      <select
        data-testid="active-issuer"
        value={activeTenantId ?? ''}
        onChange={(event) => setActiveTenantId(event.target.value)}
        className="rounded-md border border-line-strong bg-canvas px-2 py-1 text-xs text-ink"
      >
        {memberships.map((membership) => (
          <option key={membership.tenantId} value={membership.tenantId}>
            {names[membership.tenantId] ?? membership.tenantId.slice(0, 8)}
          </option>
        ))}
      </select>
    </label>
  );
}
