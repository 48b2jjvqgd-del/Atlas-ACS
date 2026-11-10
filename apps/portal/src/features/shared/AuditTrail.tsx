import type { AuditRecord } from '@atlas/contracts';
import { Fragment, useState } from 'react';
import { StatusPill } from '../../components/StatusPill';
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
import { audit, type AuditFilter } from '../../lib/endpoints';
import { useResource } from '../../lib/use-api';

const actionGroups: { value: string; label: string }[] = [
  { value: '', label: 'All actions' },
  { value: 'auth.', label: 'Sign-in and sessions' },
  { value: 'issuer.', label: 'Issuer changes' },
  { value: 'user.', label: 'User and role assignments' },
  { value: 'role.', label: 'Role definitions' },
  { value: 'access.denied', label: 'Access denied' },
];

const outcomeTone = { success: 'ok', failure: 'warn', denied: 'danger' } as const;

/**
 * Audit trail viewer: filters, keyset pagination ("older"), and a detail row with before/after
 * values and the record's hash-chain links. Read-only by design — records cannot be changed.
 */
export function AuditTrail({
  source,
  fixedFilter = {},
  compact = false,
  showTenant = false,
  tenantNames = {},
}: {
  source: { kind: 'platform' } | { kind: 'tenant'; tenantId: string };
  fixedFilter?: AuditFilter;
  compact?: boolean;
  showTenant?: boolean;
  tenantNames?: Record<string, string>;
}) {
  const [filter, setFilter] = useState<AuditFilter>({});
  const [pages, setPages] = useState<number[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const before = pages.at(-1);
  const effective = {
    ...filter,
    ...fixedFilter,
    ...(before ? { before } : {}),
    limit: compact ? 8 : 25,
  };
  const key = JSON.stringify({ source, effective });
  const { state, reload } = useResource(key, (signal) =>
    source.kind === 'platform'
      ? audit.platform(effective, signal)
      : audit.tenant(source.tenantId, effective, signal),
  );

  const update = (next: AuditFilter) => {
    setPages([]);
    setFilter(next);
  };

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="grid gap-3 md:grid-cols-4" role="search" aria-label="Filter audit records">
          <Select
            aria-label="Action"
            value={filter.action ?? ''}
            onChange={(e) => update({ ...filter, action: e.target.value || undefined })}
          >
            {actionGroups.map((group) => (
              <option key={group.value} value={group.value}>
                {group.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Outcome"
            value={filter.outcome ?? ''}
            onChange={(e) =>
              update({
                ...filter,
                outcome: (e.target.value || undefined) as AuditFilter['outcome'],
              })
            }
          >
            <option value="">All outcomes</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="denied">Denied</option>
          </Select>
          <TextInput
            aria-label="Actor ID"
            placeholder="Actor ID"
            value={filter.actorId ?? ''}
            onChange={(e) => update({ ...filter, actorId: e.target.value.trim() || undefined })}
          />
          <TextInput
            aria-label="From date"
            type="date"
            value={filter.from?.slice(0, 10) ?? ''}
            onChange={(e) =>
              update({
                ...filter,
                from: e.target.value
                  ? new Date(`${e.target.value}T00:00:00Z`).toISOString()
                  : undefined,
              })
            }
          />
        </div>
      )}

      {state.status === 'loading' && <SkeletonRows rows={compact ? 3 : 6} />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={() => void reload()} />}
      {state.status === 'loaded' && state.data.data.length === 0 && (
        <EmptyState title="No audit records">
          {pages.length > 0
            ? 'There are no older records.'
            : 'Nothing matches these filters yet. Audited actions appear here within seconds.'}
        </EmptyState>
      )}
      {state.status === 'loaded' && state.data.data.length > 0 && (
        <>
          <Table minWidth={compact ? 520 : 820}>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Action</Th>
                <Th>Actor</Th>
                {!compact && <Th>Resource</Th>}
                {showTenant && <Th>Issuer</Th>}
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody data-testid="audit-rows">
              {state.data.data.map((record) => (
                <Fragment key={record.id}>
                  <tr
                    className="cursor-pointer hover:bg-surface-hover/50"
                    onClick={() => setExpanded(expanded === record.id ? null : record.id)}
                    aria-expanded={expanded === record.id}
                  >
                    <Td className="whitespace-nowrap text-ink-muted">
                      {formatDateTime(record.occurredAt)}
                    </Td>
                    <Td>
                      <span className="font-mono text-[12px] text-ink">{record.action}</span>
                    </Td>
                    <Td className="text-ink-muted">
                      {record.actor.displayName ??
                        `${record.actor.type}:${record.actor.id.slice(0, 8)}`}
                    </Td>
                    {!compact && (
                      <Td className="text-ink-muted">
                        {record.resource.name ?? record.resource.id}{' '}
                        <span className="text-ink-subtle">({record.resource.type})</span>
                      </Td>
                    )}
                    {showTenant && (
                      <Td className="text-ink-muted">
                        {record.tenantId
                          ? (tenantNames[record.tenantId] ?? record.tenantId.slice(0, 8))
                          : 'Platform'}
                      </Td>
                    )}
                    <Td>
                      <StatusPill tone={outcomeTone[record.outcome]}>{record.outcome}</StatusPill>
                    </Td>
                  </tr>
                  {expanded === record.id && (
                    <tr>
                      <td colSpan={6} className="border-b border-line bg-canvas/60 px-4 py-4">
                        <AuditDetail record={record} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
          {!compact && (
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                disabled={pages.length === 0}
                onClick={() => setPages(pages.slice(0, -1))}
              >
                Newer
              </Button>
              <Button
                variant="ghost"
                disabled={state.data.meta.nextBefore === null}
                onClick={() =>
                  state.data.meta.nextBefore && setPages([...pages, state.data.meta.nextBefore])
                }
              >
                Older
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditDetail({ record }: { record: AuditRecord }) {
  return (
    <div className="grid gap-6 text-sm lg:grid-cols-2">
      <div>
        <p className="mb-2 text-xs uppercase tracking-wider text-ink-subtle">Changes</p>
        {record.changes && record.changes.length > 0 ? (
          <table className="w-full text-xs">
            <thead className="text-ink-subtle">
              <tr>
                <th className="py-1 pr-3 text-left font-medium">Field</th>
                <th className="py-1 pr-3 text-left font-medium">Before</th>
                <th className="py-1 text-left font-medium">After</th>
              </tr>
            </thead>
            <tbody>
              {record.changes.map((change) => (
                <tr key={change.field}>
                  <td className="py-1 pr-3 font-mono text-ink">{change.field}</td>
                  <td className="py-1 pr-3 text-ink-muted">{String(change.before ?? '—')}</td>
                  <td className="py-1 text-ink">{String(change.after ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-ink-subtle">No field changes recorded.</p>
        )}
        {record.reason && (
          <p className="mt-3 text-ink-muted">
            <span className="text-ink-subtle">Reason: </span>
            {record.reason}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-subtle">Record</dt>
        <dd className="font-mono text-ink-muted">
          #{record.sequence} · {record.id}
        </dd>
        <dt className="text-ink-subtle">Correlation</dt>
        <dd className="font-mono text-ink-muted">{record.correlationId}</dd>
        <dt className="text-ink-subtle">Source</dt>
        <dd className="text-ink-muted">{record.sourceService}</dd>
        {record.metadata &&
          Object.entries(record.metadata)
            .filter(([, value]) => value !== null)
            .map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-ink-subtle">{key}</dt>
                <dd className="text-ink-muted">{String(value)}</dd>
              </Fragment>
            ))}
        <dt className="text-ink-subtle">Chain</dt>
        <dd className="font-mono text-ink-muted">
          {record.chain === 'platform' ? 'platform' : 'issuer'}
        </dd>
        <dt className="text-ink-subtle">Hash</dt>
        <dd className="break-all font-mono text-[11px] text-ink-subtle">{record.hash}</dd>
      </dl>
    </div>
  );
}
