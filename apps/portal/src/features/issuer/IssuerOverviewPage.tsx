import { Link } from 'react-router';
import { Card } from '../../components/Card';
import { KeyValues, StatTile, formatDateTime } from '../../components/ui';
import { identity, issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useTenant } from '../../lib/tenant';
import { useResource } from '../../lib/use-api';
import { AuditTrail } from '../shared/AuditTrail';
import { IssuerStatus } from '../shared/IssuerStatus';
import { IssuerWorkspace } from './IssuerWorkspace';

export function IssuerOverviewPage() {
  return (
    <IssuerWorkspace
      title="Issuer overview"
      description="Your issuer at a glance: status, configuration, people and recent changes."
    >
      {(tenant) => <Overview tenantId={tenant.id} />}
    </IssuerWorkspace>
  );
}

function Overview({ tenantId }: { tenantId: string }) {
  const { session } = useSession();
  const { canInTenant } = useTenant();
  const tenant = useResource(`issuer:${tenantId}`, (signal) => issuers.get(tenantId, signal));
  const configuration = useResource(
    canInTenant('issuer.configuration.read') ? `configuration:${tenantId}` : null,
    (signal) => issuers.configuration(tenantId, signal),
  );
  const users = useResource(
    canInTenant('issuer.users.read') ? `users:${tenantId}` : null,
    (signal) => identity.tenantUsers(tenantId, signal),
  );
  const membership = session?.principal.tenants.find((t) => t.tenantId === tenantId);
  if (tenant.state.status !== 'loaded') return null;
  const issuer = tenant.state.data;
  const settings =
    configuration.state.status === 'loaded' ? configuration.state.data.settings : null;

  return (
    <div className="space-y-4" data-testid="tenant-context">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Status"
          value={<IssuerStatus status={issuer.status} />}
          hint={`Since ${formatDateTime(issuer.updatedAt)}`}
        />
        <StatTile
          label="Your roles"
          value={membership?.roles.length ?? 0}
          hint={membership?.roles.join(', ')}
        />
        {canInTenant('issuer.users.read') && (
          <StatTile
            label="Users"
            value={users.state.status === 'loaded' ? users.state.data.length : '…'}
            hint="With access to this issuer"
          />
        )}
        {settings && (
          <StatTile
            label="Schemes"
            value={
              [
                settings.schemeParticipation.visa && 'Visa',
                settings.schemeParticipation.mastercard && 'Mastercard',
              ]
                .filter(Boolean)
                .join(' · ') || 'None'
            }
            hint="Simulated directory servers"
          />
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Profile" className={canInTenant('audit.read') ? '' : 'lg:col-span-3'}>
          <KeyValues
            items={[
              { label: 'Name', value: issuer.displayName },
              {
                label: 'Reference',
                value: <span className="font-mono">{issuer.internalReference ?? '—'}</span>,
              },
              ...(settings
                ? [
                    { label: 'Time zone', value: settings.timezone },
                    { label: 'Support contact', value: settings.supportContactEmail ?? '—' },
                  ]
                : []),
            ]}
          />
          {canInTenant('issuer.configuration.read') && (
            <Link
              to="/issuer/configuration"
              className="mt-4 inline-block text-sm text-accent-strong hover:underline"
            >
              Profile and configuration
            </Link>
          )}
        </Card>
        {canInTenant('audit.read') && (
          <Card
            title="Recent changes"
            className="lg:col-span-2"
            actions={
              <Link to="/issuer/audit" className="text-sm text-accent-strong hover:underline">
                Audit history
              </Link>
            }
          >
            <AuditTrail source={{ kind: 'tenant', tenantId }} compact />
          </Card>
        )}
      </div>
      <Card title="Coming next">
        <p className="text-sm leading-6 text-ink-muted">
          Authentication activity arrives with the ACS protocol engine (Stage 1B), fraud rules in
          Stage 2, challenge methods in Stage 3, compliance in Stage 4 and reporting in Stage 5. No
          sample figures are shown until those services process real (synthetic) transactions.
        </p>
      </Card>
    </div>
  );
}
