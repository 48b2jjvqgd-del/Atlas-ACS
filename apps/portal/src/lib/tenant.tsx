import type { Permission, TenantSummary } from '@atlas/contracts';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { issuers } from './endpoints';
import { useSession } from './session';

/**
 * The issuer the user is working in (issuer workspace).
 *
 * Only issuers the user is a member of can be selected — they come from the verified principal,
 * not from anything the browser supplies. Names are looked up from the issuer registry, which
 * itself returns only issuers the user may read. The choice is remembered per tab.
 */
interface TenantContextValue {
  memberships: { tenantId: string; roles: string[] }[];
  activeTenantId: string | null;
  activeTenant: TenantSummary | null;
  names: Record<string, string>;
  setActiveTenantId(id: string): void;
  canInTenant(permission: Permission): boolean;
}

const TenantContext = createContext<TenantContextValue | null>(null);
const STORAGE_KEY = 'atlas.activeTenant';

function readStored(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function TenantProvider({ children }: { children: ReactNode }) {
  const { session, can } = useSession();
  const memberships = useMemo(() => session?.principal.tenants ?? [], [session]);
  const [selected, setSelected] = useState<string | null>(readStored);
  const [directory, setDirectory] = useState<Record<string, TenantSummary>>({});

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    issuers
      .list({}, controller.signal)
      .then((result) =>
        setDirectory(Object.fromEntries(result.data.map((tenant) => [tenant.id, tenant]))),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [session]);

  const activeTenantId = memberships.some((m) => m.tenantId === selected)
    ? selected
    : (memberships[0]?.tenantId ?? null);

  const value = useMemo<TenantContextValue>(
    () => ({
      memberships,
      activeTenantId,
      activeTenant: activeTenantId ? (directory[activeTenantId] ?? null) : null,
      names: Object.fromEntries(
        Object.values(directory).map((tenant) => [tenant.id, tenant.displayName]),
      ),
      setActiveTenantId(id) {
        setSelected(id);
        try {
          window.sessionStorage.setItem(STORAGE_KEY, id);
        } catch {
          /* storage unavailable: selection lasts for this page only */
        }
      },
      canInTenant: (permission) => (activeTenantId ? can(permission, activeTenantId) : false),
    }),
    [memberships, activeTenantId, directory, can],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantContextValue {
  const value = useContext(TenantContext);
  if (!value) throw new Error('useTenant must be used inside TenantProvider');
  return value;
}
