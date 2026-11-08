import type { NavigationItem, Workspace } from '../app/navigation';
import { PageHeader } from '../components/PageHeader';
import { PlannedFeature } from '../components/PlannedFeature';

export function PlannedPage({ workspace, item }: { workspace: Workspace; item: NavigationItem }) {
  if (item.availability.status !== 'planned') return null;
  return (
    <>
      <PageHeader eyebrow={`${workspace.label} workspace`} title={item.label} />
      <PlannedFeature stage={item.availability.stage} summary={item.availability.summary} />
    </>
  );
}
