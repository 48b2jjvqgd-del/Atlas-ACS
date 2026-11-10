import { Link } from 'react-router';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { Button, ErrorState, SkeletonRows, StatTile } from '../../components/ui';
import { identity, issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { usePlatformServices } from '../../lib/use-platform-services';
import { AuditTrail } from '../shared/AuditTrail';

/**
 * Platform overview. Every figure is a count of real records from the APIs; there are no
 * authentication statistics until the ACS processes transactions (Stage 1B onwards).
 */
export function PlatformOverviewPage() {
  const { can, session } = useSession();
  const registry = useResource(can('issuer.read') ? 'issuers' : null, (signal) =>
    issuers.list({}, signal),
  );
  const users = useResource(can('platform.users.read') ? 'platform-users' : null, (signal) =>
    identity.platformUsers(signal),
  );

  const counts =
    registry.state.status === 'loaded'
      ? registry.state.data.data.reduce<Record<string, number>>(
          (acc, tenant) => ({ ...acc, [tenant.status]: (acc[tenant.status] ?? 0) + 1 }),
          {},
        )
      : null;
  const names =
    registry.state.status === 'loaded'
      ? Object.fromEntries(registry.state.data.data.map((t) => [t.id, t.displayName]))
      : {};

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Platform overview"
        description={`Welcome back, ${session?.principal.displayName.split(' ')[0] ?? ''}. The issuer registry, platform users and recent administrative activity across ATLAS.`}
        actions={
          can('issuer.create') && (
            <Link to="/platform/issuers/new">
              <Button variant="primary">
                <Icon name="plus" className="size-4" /> Register issuer
              </Button>
            </Link>
          )
        }
      />

      {can('issuer.read') && (
        <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="issuer-counts">
          {registry.state.status === 'error' ? (
            <div className="sm:col-span-2 xl:col-span-4">
              <ErrorState error={registry.state.error} onRetry={() => void registry.reload()} />
            </div>
          ) : (
            <>
              <StatTile
                label="Issuers"
                value={registry.state.status === 'loaded' ? registry.state.data.meta.total : '…'}
                hint="Registered on the platform"
              />
              <StatTile
                label="Active"
                value={counts ? (counts.active ?? 0) : '…'}
                hint="Live for authentication"
              />
              <StatTile
                label="Onboarding"
                value={counts ? (counts.onboarding ?? 0) : '…'}
                hint="Being configured"
              />
              <StatTile
                label="Suspended"
                value={counts ? (counts.suspended ?? 0) : '…'}
                hint="Temporarily disabled"
              />
            </>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {can('audit.read') && (
          <Card
            title="Recent activity"
            description="Latest audited actions across the platform."
            className="lg:col-span-2"
            actions={
              <Link to="/platform/audit" className="text-sm text-accent-strong hover:underline">
                Audit explorer
              </Link>
            }
          >
            <AuditTrail source={{ kind: 'platform' }} compact showTenant tenantNames={names} />
          </Card>
        )}
        <div className="space-y-4">
          {can('platform.health.read') && <HealthSummary />}
          {can('platform.users.read') && (
            <Card
              title="Platform users"
              actions={
                <Link to="/platform/users" className="text-sm text-accent-strong hover:underline">
                  Manage
                </Link>
              }
            >
              {users.state.status === 'loaded' ? (
                <p className="text-sm text-ink-muted">
                  <span className="text-2xl font-semibold text-ink">{users.state.data.length}</span>{' '}
                  people hold platform roles;{' '}
                  {users.state.data.filter((u) => u.status === 'active').length} active.
                </p>
              ) : users.state.status === 'error' ? (
                <ErrorState error={users.state.error} />
              ) : (
                <SkeletonRows rows={1} />
              )}
            </Card>
          )}
          <Card title="Environment">
            <p className="text-sm leading-6 text-ink-muted">
              Development and simulation only. All issuers, users and data are synthetic; there is
              no connectivity to Visa or Mastercard.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

function HealthSummary() {
  const { state } = usePlatformServices(30_000);
  const ready =
    state.status === 'loaded' ? state.data.services.filter((s) => s.status === 'ready').length : 0;
  return (
    <Card
      title="System health"
      actions={
        state.status === 'loaded' ? (
          <StatusPill
            tone={ready === state.data.services.length ? 'ok' : 'warn'}
          >{`${ready} / ${state.data.services.length} ready`}</StatusPill>
        ) : state.status === 'error' ? (
          <StatusPill tone="danger">Unavailable</StatusPill>
        ) : undefined
      }
    >
      <Link to="/platform/health" className="text-sm text-accent-strong hover:underline">
        View service readiness
      </Link>
    </Card>
  );
}
