import { useState } from 'react';
import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { StatusPill } from '../../components/StatusPill';
import { Button, ErrorState, Select } from '../../components/ui';
import { audit, issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { AuditTrail } from '../shared/AuditTrail';

export function AuditExplorerPage() {
  const { can } = useSession();
  const registry = useResource('issuers', (signal) => issuers.list({}, signal));
  const [tenantId, setTenantId] = useState('');
  const [verification, setVerification] = useState<Awaited<ReturnType<typeof audit.verify>> | null>(
    null,
  );
  const [verifyError, setVerifyError] = useState<unknown>(null);
  const [verifying, setVerifying] = useState(false);
  const names =
    registry.state.status === 'loaded'
      ? Object.fromEntries(registry.state.data.data.map((t) => [t.id, t.displayName]))
      : {};

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Audit explorer"
        description="Append-only, hash-chained record of sign-ins, administrative changes and denied access across ATLAS. Records cannot be edited or deleted."
        actions={
          can('audit.verify') && (
            <Button
              busy={verifying}
              onClick={async () => {
                setVerifying(true);
                setVerifyError(null);
                try {
                  setVerification(await audit.verify(tenantId || 'platform'));
                } catch (error) {
                  setVerifyError(error);
                } finally {
                  setVerifying(false);
                }
              }}
            >
              Verify {tenantId ? 'issuer' : 'platform'} chain
            </Button>
          )
        }
      />
      {verification && (
        <div
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-5 py-3 text-sm"
          data-testid="chain-verification"
        >
          <StatusPill tone={verification.valid ? 'ok' : 'danger'}>
            {verification.valid ? 'Chain intact' : 'Chain broken'}
          </StatusPill>
          <span className="text-ink-muted">
            {verification.records} records verified
            {verification.firstInvalidSequence !== null &&
              ` · first mismatch at #${verification.firstInvalidSequence}`}
          </span>
        </div>
      )}
      {verifyError !== null && (
        <div className="mb-4">
          <ErrorState error={verifyError} />
        </div>
      )}
      <Card>
        <div className="mb-4 max-w-xs">
          <Select
            aria-label="Issuer"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          >
            <option value="">All issuers and platform</option>
            {Object.entries(names).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </div>
        <AuditTrail
          source={{ kind: 'platform' }}
          fixedFilter={tenantId ? { tenantId } : {}}
          showTenant
          tenantNames={names}
        />
      </Card>
    </>
  );
}
