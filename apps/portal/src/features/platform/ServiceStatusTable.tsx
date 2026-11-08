import type { ServiceStatus } from '@atlas/contracts';
import { StatusPill } from '../../components/StatusPill';

const statusTone = { ready: 'ok', not_ready: 'warn', unreachable: 'danger' } as const;
const statusLabel = { ready: 'Ready', not_ready: 'Not ready', unreachable: 'Unreachable' } as const;

export function ServiceStatusTable({ services }: { services: ServiceStatus[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-ink-subtle">
          <tr className="border-b border-line">
            <th scope="col" className="py-3 pr-4 font-medium">
              Service
            </th>
            <th scope="col" className="py-3 pr-4 font-medium">
              Status
            </th>
            <th scope="col" className="py-3 pr-4 font-medium">
              Dependencies
            </th>
            <th scope="col" className="py-3 pr-4 font-medium">
              Version
            </th>
            <th scope="col" className="py-3 text-right font-medium">
              Probe latency
            </th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => (
            <tr
              key={service.service}
              className="border-b border-line/60 last:border-0"
              data-testid={`service-row-${service.service}`}
            >
              <td className="py-3 pr-4 font-mono text-[13px] text-ink">{service.service}</td>
              <td className="py-3 pr-4">
                <StatusPill tone={statusTone[service.status]}>
                  {statusLabel[service.status]}
                </StatusPill>
              </td>
              <td className="py-3 pr-4">
                {service.checks.length === 0 ? (
                  <span className="text-ink-subtle">
                    {service.status === 'unreachable' ? '—' : 'none'}
                  </span>
                ) : (
                  <span className="flex flex-wrap gap-1.5">
                    {service.checks.map((check) => (
                      <span
                        key={check.name}
                        title={
                          check.error
                            ? `${check.name}: ${check.error}`
                            : `${check.name}: ${check.latencyMs} ms`
                        }
                        className={`rounded px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset ${
                          check.status === 'up'
                            ? 'text-ok ring-ok/30'
                            : 'text-danger ring-danger/30'
                        }`}
                      >
                        {check.name}
                      </span>
                    ))}
                  </span>
                )}
              </td>
              <td className="py-3 pr-4 font-mono text-[13px] text-ink-muted">
                {service.version ?? '—'}
              </td>
              <td className="py-3 text-right font-mono text-[13px] text-ink-muted">
                {service.latencyMs === null ? '—' : `${service.latencyMs.toFixed(1)} ms`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
