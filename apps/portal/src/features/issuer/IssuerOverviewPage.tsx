import { Card } from '../../components/Card';
import { PageHeader } from '../../components/PageHeader';
import { PlannedFeature } from '../../components/PlannedFeature';

export function IssuerOverviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Issuer workspace"
        title="Issuer overview"
        description="Everything in this workspace is scoped to a single issuer. Tenant isolation is enforced by the backend, not by this interface."
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Active issuer" description="Tenant context for this workspace.">
          <p className="text-sm text-ink-muted" data-testid="tenant-context">
            No issuer selected.
          </p>
          <p className="mt-2 text-xs leading-5 text-ink-subtle">
            Tenant selection is derived from the signed-in user&apos;s authorised tenants in Stage
            1.
          </p>
        </Card>
        <div className="lg:col-span-2">
          <PlannedFeature
            stage="1B"
            summary="Authentication volumes and frictionless / challenge / decline outcomes for the selected issuer, sourced from the reporting service."
          />
        </div>
      </div>
    </>
  );
}
