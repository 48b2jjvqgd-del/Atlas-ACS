import type { TenantSummary } from '@atlas/contracts';
import type { ReactNode } from 'react';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, SkeletonRows } from '../../components/ui';
import { issuers } from '../../lib/endpoints';
import { useTenant } from '../../lib/tenant';
import { useResource } from '../../lib/use-api';

/** Loads the active issuer for issuer-workspace pages; the tenant comes from the user's memberships. */
export function IssuerWorkspace({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: (tenant: TenantSummary) => ReactNode;
}) {
  const { activeTenantId } = useTenant();
  const { state, reload } = useResource(
    activeTenantId ? `issuer:${activeTenantId}` : null,
    (signal) => issuers.get(activeTenantId!, signal),
  );
  if (!activeTenantId) {
    return (
      <>
        <PageHeader eyebrow="Issuer" title={title} />
        <EmptyState title="You are not a member of any issuer">
          Issuer workspaces are available to users assigned to an issuer. Ask an administrator to
          add you.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      <PageHeader
        eyebrow={state.status === 'loaded' ? state.data.displayName : 'Issuer'}
        title={title}
        {...(description ? { description } : {})}
      />
      {state.status === 'loading' && <SkeletonRows rows={5} />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={() => void reload()} />}
      {state.status === 'loaded' && children(state.data)}
    </>
  );
}
