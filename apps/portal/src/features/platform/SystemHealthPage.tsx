import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { usePlatformServices } from '../../lib/use-platform-services';
import { GatewayUnavailable } from './GatewayUnavailable';
import { ServiceStatusTable } from './ServiceStatusTable';

export function SystemHealthPage() {
  const { state, refresh } = usePlatformServices();

  const summary =
    state.status === 'loaded'
      ? {
          ready: state.data.services.filter((s) => s.status === 'ready').length,
          total: state.data.services.length,
        }
      : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="System health"
        description="Live readiness of every ATLAS service, probed by the API gateway. Refreshes every 15 seconds."
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface-raised px-3 py-1.5 text-sm text-ink hover:bg-surface-hover"
          >
            <Icon name="refresh" className="size-4" /> Refresh
          </button>
        }
      />
      <Card
        title="Services"
        description={
          state.status === 'loaded'
            ? `Checked ${new Date(state.data.checkedAt).toLocaleTimeString()}`
            : 'Data source: GET /v1/platform/services'
        }
        actions={
          summary && (
            <StatusPill tone={summary.ready === summary.total ? 'ok' : 'warn'}>
              {`${summary.ready} of ${summary.total} ready`}
            </StatusPill>
          )
        }
      >
        {state.status === 'loading' && <p className="text-sm text-ink-muted">Probing services…</p>}
        {state.status === 'error' && <GatewayUnavailable error={state.error} />}
        {state.status === 'loaded' && <ServiceStatusTable services={state.data.services} />}
      </Card>
    </>
  );
}
