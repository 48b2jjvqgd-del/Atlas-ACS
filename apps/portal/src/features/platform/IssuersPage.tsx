import type { TenantStatus } from '@atlas/contracts';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import {
  Button,
  EmptyState,
  ErrorState,
  Select,
  SkeletonRows,
  Table,
  Td,
  TextInput,
  Th,
  formatDateTime,
} from '../../components/ui';
import { issuers } from '../../lib/endpoints';
import { useSession } from '../../lib/session';
import { useResource } from '../../lib/use-api';
import { IssuerStatus } from '../shared/IssuerStatus';

export function IssuersPage() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<TenantStatus | ''>('');
  const { state, reload } = useResource(`issuers:${q}:${status}`, (signal) =>
    issuers.list({ q: q || undefined, status: status || undefined }, signal),
  );

  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Issuers"
        description="Every issuer is an isolated tenant: its users, configuration and audit trail are visible only to its members and to platform administrators."
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
      <Card>
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_200px]" role="search">
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-ink-subtle"
            />
            <TextInput
              aria-label="Search issuers"
              placeholder="Search by name, slug or reference"
              className="pl-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as TenantStatus | '')}
          >
            <option value="">All statuses</option>
            <option value="onboarding">Onboarding</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="offboarded">Offboarded</option>
          </Select>
        </div>
        {state.status === 'loading' && <SkeletonRows />}
        {state.status === 'error' && (
          <ErrorState error={state.error} onRetry={() => void reload()} />
        )}
        {state.status === 'loaded' && state.data.data.length === 0 && (
          <EmptyState title={q || status ? 'No issuers match' : 'No issuers registered'}>
            {q || status
              ? 'Try a different search or status.'
              : 'Register the first synthetic issuer to get started.'}
          </EmptyState>
        )}
        {state.status === 'loaded' && state.data.data.length > 0 && (
          <Table minWidth={720}>
            <thead>
              <tr>
                <Th>Issuer</Th>
                <Th>Reference</Th>
                <Th>Status</Th>
                <Th>Registered</Th>
                <Th align="right">Updated</Th>
              </tr>
            </thead>
            <tbody data-testid="issuer-rows">
              {state.data.data.map((tenant) => (
                <tr
                  key={tenant.id}
                  className="cursor-pointer hover:bg-surface-hover/50"
                  onClick={() => navigate(`/platform/issuers/${tenant.id}`)}
                >
                  <Td>
                    <Link
                      to={`/platform/issuers/${tenant.id}`}
                      className="font-medium text-ink hover:text-accent-strong"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {tenant.displayName}
                    </Link>
                    <p className="font-mono text-[11px] text-ink-subtle">{tenant.slug}</p>
                  </Td>
                  <Td className="font-mono text-[13px] text-ink-muted">
                    {tenant.internalReference ?? '—'}
                  </Td>
                  <Td>
                    <IssuerStatus status={tenant.status} />
                  </Td>
                  <Td className="text-ink-muted">{formatDateTime(tenant.createdAt)}</Td>
                  <Td className="text-right text-ink-muted">{formatDateTime(tenant.updatedAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
