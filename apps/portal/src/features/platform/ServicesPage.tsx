import { serviceCatalog, serviceNames } from '@atlas/contracts';
import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';

/** The service catalogue as defined in @atlas/contracts — the actual architecture, not sample data. */
export function ServicesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Platform"
        title="Services"
        description="The ATLAS service catalogue: each service's responsibility and the data stores it exclusively owns. Source: @atlas/contracts."
      />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {serviceNames.map((name) => {
          const entry = serviceCatalog[name];
          return (
            <Card key={name}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-mono text-sm text-ink">{name}</h2>
                <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle ring-1 ring-inset ring-line-strong">
                  {entry.domain}
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-ink-muted">{entry.summary}</p>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-ink-subtle">PostgreSQL schema</dt>
                <dd className="font-mono text-ink-muted">
                  {entry.dataStores.postgresSchema ?? 'none (stateless)'}
                </dd>
                <dt className="text-ink-subtle">Valkey key prefix</dt>
                <dd className="font-mono text-ink-muted">
                  {entry.dataStores.valkeyPrefix ?? 'none'}
                </dd>
                <dt className="text-ink-subtle">Local port</dt>
                <dd className="font-mono text-ink-muted">{entry.port}</dd>
              </dl>
            </Card>
          );
        })}
      </div>
    </>
  );
}
