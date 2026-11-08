import type { StageId } from '../app/navigation';
import { Icon } from './Icon';

/** Explicit placeholder for functionality that does not exist yet. Never shows sample data. */
export function PlannedFeature({ stage, summary }: { stage: StageId; summary: string }) {
  return (
    <div
      role="note"
      aria-label="Placeholder"
      className="rounded-xl border border-dashed border-line-strong bg-surface/60 px-6 py-10 text-center"
    >
      <span className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
        <Icon name="lock" />
      </span>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-subtle">
        Placeholder · Planned for Stage {stage}
      </p>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-ink-muted">{summary}</p>
      <p className="mx-auto mt-4 max-w-xl text-xs text-ink-subtle">
        This area is intentionally empty. No sample or simulated figures are displayed until the
        underlying service is implemented.
      </p>
    </div>
  );
}
