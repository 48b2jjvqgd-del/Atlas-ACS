import { Link } from 'react-router';
import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { PlannedFeature } from '../../components/PlannedFeature';
import { StatusPill } from '../../components/StatusPill';
import { usePlatformServices } from '../../lib/use-platform-services';

export function PlatformOverviewPage() {
  const { state } = usePlatformServices(30_000);
  return (
    <>
      <PageHeader
        eyebrow="Platform administration"
        title="Platform overview"
        description="Cross-tenant operation of ATLAS. Available to platform administrators only once access control is introduced."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Service readiness" description="Live, from the API gateway.">
          {state.status === 'loading' && <p className="text-sm text-ink-muted">Checking…</p>}
          {state.status === 'error' && <StatusPill tone="danger">Gateway unreachable</StatusPill>}
          {state.status === 'loaded' && (
            <p className="text-3xl font-semibold tabular-nums text-ink">
              {state.data.services.filter((s) => s.status === 'ready').length}
              <span className="text-base font-normal text-ink-subtle">
                {' '}
                / {state.data.services.length} ready
              </span>
            </p>
          )}
          <Link
            to="/platform/health"
            className="mt-4 inline-block text-sm text-accent-strong hover:underline"
          >
            View system health
          </Link>
        </Card>
        <div className="lg:col-span-2">
          <PlannedFeature
            stage="1A"
            summary="Tenant counts, onboarding status and platform-wide configuration changes will appear here once the issuer registry and audit capture are implemented."
          />
        </div>
      </div>
    </>
  );
}
