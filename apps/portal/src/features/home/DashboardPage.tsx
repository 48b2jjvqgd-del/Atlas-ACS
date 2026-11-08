import { Link } from 'react-router';
import { workspaces } from '../../app/navigation';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { usePlatformServices } from '../../lib/use-platform-services';

export function DashboardPage() {
  const { state } = usePlatformServices(30_000);
  const ready =
    state.status === 'loaded' ? state.data.services.filter((s) => s.status === 'ready').length : 0;

  return (
    <>
      <PageHeader
        eyebrow="ATLAS ACS"
        title="Welcome to ATLAS"
        description="An independent, extensible EMV 3-D Secure Access Control Server. This build is a Stage 0 foundation running in a development and simulation environment — no scheme connectivity and no real cardholder data."
      />

      <div className="grid gap-4 md:grid-cols-2">
        {workspaces.map((workspace) => (
          <Link
            key={workspace.id}
            to={workspace.basePath}
            data-testid={`workspace-entry-${workspace.id}`}
            className="group rounded-xl border border-line bg-surface p-6 transition-colors hover:border-accent/50 hover:bg-surface-raised"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-strong">
              {workspace.id === 'platform' ? 'Platform administration' : 'Issuer workspace'}
            </p>
            <p className="mt-3 text-lg font-semibold text-ink">{workspace.label}</p>
            <p className="mt-2 text-sm leading-6 text-ink-muted">{workspace.description}</p>
            <p className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-ink group-hover:text-accent-strong">
              Open {workspace.label.toLowerCase()} workspace{' '}
              <Icon name="arrow-right" className="size-4" />
            </p>
          </Link>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card
          title="Platform status"
          description="Live readiness reported by the API gateway."
          actions={
            state.status === 'loaded' ? (
              <StatusPill tone={ready === state.data.services.length ? 'ok' : 'warn'}>
                {`${ready} / ${state.data.services.length} ready`}
              </StatusPill>
            ) : state.status === 'error' ? (
              <StatusPill tone="danger">Gateway unreachable</StatusPill>
            ) : undefined
          }
        >
          <Link to="/platform/health" className="text-sm text-accent-strong hover:underline">
            View system health
          </Link>
        </Card>
        <Card title="Build" className="lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-subtle">Stage</dt>
              <dd className="mt-1 text-ink">0 · Platform foundation</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Data</dt>
              <dd className="mt-1 text-ink">Synthetic only</dd>
            </div>
            <div>
              <dt className="text-ink-subtle">Scheme connectivity</dt>
              <dd className="mt-1 text-ink">None — simulation planned</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
