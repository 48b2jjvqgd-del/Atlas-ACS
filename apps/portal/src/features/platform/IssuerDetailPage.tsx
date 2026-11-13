import { tenantStatusTransitions, type TenantStatus, type TenantSummary } from '@atlas/contracts';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import {
  Button,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Field,
  KeyValues,
  SkeletonRows,
  Tabs,
  TextInput,
  formatDateTime,
  useToast,
} from '../../components/ui';
import { issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { AuditTrail } from '../shared/AuditTrail';
import { IssuerConfiguration } from '../shared/IssuerConfiguration';
import { IssuerStatus } from '../shared/IssuerStatus';
import { TenantUsers } from '../shared/TenantUsers';

type Tab = 'overview' | 'configuration' | 'users' | 'audit';

const actionFor: Record<
  Exclude<TenantStatus, 'onboarding'>,
  { label: string; verb: string; tone: 'primary' | 'danger'; effect: string }
> = {
  active: {
    label: 'Activate',
    verb: 'activate',
    tone: 'primary',
    effect:
      'The issuer becomes live for authentication (from Stage 1B) and its users keep their access.',
  },
  suspended: {
    label: 'Suspend',
    verb: 'suspend',
    tone: 'danger',
    effect:
      'Authentication for this issuer stops (from Stage 1B). Its configuration and users are kept and it can be reactivated.',
  },
  offboarded: {
    label: 'Offboard',
    verb: 'offboard',
    tone: 'danger',
    effect: 'This is permanent. The issuer can no longer be changed or reactivated.',
  },
};

export function IssuerDetailPage() {
  const { tenantId = '' } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [transition, setTransition] = useState<Exclude<TenantStatus, 'onboarding'> | null>(null);
  const [editing, setEditing] = useState(false);
  const { state, reload } = useResource(`issuer:${tenantId}`, (signal) =>
    issuers.get(tenantId, signal),
  );

  if (state.status === 'loading') return <SkeletonRows rows={6} />;
  if (state.status === 'error') {
    return (
      <>
        <PageHeader eyebrow="Platform · Issuers" title="Issuer" />
        <ErrorState error={state.error} onRetry={() => void reload()} />
      </>
    );
  }
  const tenant = state.data;
  const transitions = can('issuer.status.manage', tenantId)
    ? tenantStatusTransitions[tenant.status]
    : [];
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    ...(can('issuer.configuration.read', tenantId)
      ? [{ id: 'configuration' as const, label: 'Configuration' }]
      : []),
    ...(can('issuer.users.read', tenantId) ? [{ id: 'users' as const, label: 'Users' }] : []),
    ...(can('audit.read', tenantId) ? [{ id: 'audit' as const, label: 'Audit history' }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Platform · Issuers"
        title={tenant.displayName}
        description={
          <span className="inline-flex flex-wrap items-center gap-3">
            <IssuerStatus status={tenant.status} />
            <span className="font-mono text-xs">{tenant.internalReference}</span>
            {tenant.isSynthetic && (
              <span className="text-xs text-ink-subtle">Synthetic issuer</span>
            )}
          </span>
        }
        actions={
          <>
            <Link to="/platform/issuers" className="text-sm text-ink-muted hover:text-ink">
              All issuers
            </Link>
            {(transitions as Exclude<TenantStatus, 'onboarding'>[]).map((status) => (
              <Button
                key={status}
                variant={actionFor[status].tone === 'danger' ? 'danger' : 'primary'}
                onClick={() => setTransition(status)}
              >
                {actionFor[status].label}
              </Button>
            ))}
          </>
        }
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card
            title="Profile"
            className="lg:col-span-2"
            actions={
              can('issuer.update', tenantId) &&
              tenant.status !== 'offboarded' && (
                <Button variant="ghost" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )
            }
          >
            <KeyValues
              items={[
                { label: 'Name', value: tenant.displayName },
                {
                  label: 'Internal reference',
                  value: <span className="font-mono">{tenant.internalReference ?? '—'}</span>,
                },
                { label: 'Slug', value: <span className="font-mono">{tenant.slug}</span> },
                {
                  label: 'Issuer ID',
                  value: <span className="font-mono text-xs">{tenant.id}</span>,
                },
                { label: 'Registered', value: formatDateTime(tenant.createdAt) },
                { label: 'Last updated', value: formatDateTime(tenant.updatedAt) },
              ]}
            />
          </Card>
          <Card title="Lifecycle">
            <ol className="space-y-2 text-sm">
              {(['onboarding', 'active', 'suspended', 'offboarded'] as const).map((status) => (
                <li
                  key={status}
                  className={`flex items-center gap-2 ${status === tenant.status ? 'text-ink' : 'text-ink-subtle'}`}
                >
                  <span
                    className={`size-2 rounded-full ${status === tenant.status ? 'bg-accent' : 'bg-line-strong'}`}
                  />
                  {status[0]!.toUpperCase() + status.slice(1)}
                  {status === tenant.status && (
                    <span className="text-xs text-ink-muted">(current)</span>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs leading-5 text-ink-subtle">
              Every status change requires a reason and is recorded in the audit trail.
            </p>
          </Card>
        </div>
      )}
      {tab === 'configuration' && (
        <IssuerConfiguration
          tenantId={tenantId}
          {...(tenant.status === 'offboarded'
            ? { readOnlyReason: 'Offboarded issuers cannot be reconfigured.' }
            : {})}
        />
      )}
      {tab === 'users' && (
        <Card>
          <TenantUsers tenantId={tenantId} issuerName={tenant.displayName} />
        </Card>
      )}
      {tab === 'audit' && (
        <Card
          title="Audit history"
          description="Every change to this issuer, its configuration and its users."
        >
          <AuditTrail source={{ kind: 'tenant', tenantId }} />
        </Card>
      )}

      {transition && (
        <ConfirmDialog
          title={`${actionFor[transition].label} ${tenant.displayName}?`}
          description={actionFor[transition].effect}
          confirmLabel={actionFor[transition].label}
          tone={actionFor[transition].tone}
          requireReason
          {...(transition === 'offboarded'
            ? { typeToConfirm: tenant.internalReference ?? tenant.slug }
            : {})}
          onClose={() => setTransition(null)}
          onConfirm={async (reason) => {
            await issuers.setStatus(tenantId, transition, reason);
            toast('success', `${tenant.displayName} is now ${transition}.`);
            setTransition(null);
            await reload();
          }}
        />
      )}
      {editing && (
        <EditProfileDialog
          tenant={tenant}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            toast('success', 'Issuer profile updated.');
            setEditing(false);
            await reload();
          }}
        />
      )}
    </>
  );
}

function EditProfileDialog({
  tenant,
  onClose,
  onSaved,
}: {
  tenant: TenantSummary;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(tenant.displayName);
  const [reference, setReference] = useState(tenant.internalReference ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      title="Edit issuer profile"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={
              displayName.trim() === tenant.displayName &&
              reference === (tenant.internalReference ?? '')
            }
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await issuers.update(tenant.id, {
                  ...(displayName.trim() !== tenant.displayName
                    ? { displayName: displayName.trim() }
                    : {}),
                  ...(reference !== (tenant.internalReference ?? '')
                    ? { internalReference: reference }
                    : {}),
                });
                await onSaved();
              } catch (failure) {
                setError(failure);
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <Field label="Issuer name">
        {(id) => (
          <TextInput id={id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        )}
      </Field>
      <Field label="Internal reference">
        {(id) => (
          <TextInput
            id={id}
            value={reference}
            onChange={(e) => setReference(e.target.value.toUpperCase())}
          />
        )}
      </Field>
      {error !== null && <ErrorState error={error} />}
    </Dialog>
  );
}
