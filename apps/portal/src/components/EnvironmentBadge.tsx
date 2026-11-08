import { portalEnvironment, schemeConnectivity } from '../lib/environment';

export function EnvironmentBadge() {
  return (
    <div
      className="flex items-center overflow-hidden rounded-md text-[11px] font-semibold tracking-[0.14em] ring-1 ring-inset ring-warn/40"
      role="status"
      aria-label={`Environment: ${portalEnvironment}, scheme connectivity: ${schemeConnectivity}`}
      data-testid="environment-indicator"
    >
      <span className="bg-warn-soft px-2.5 py-1 text-warn">{portalEnvironment.toUpperCase()}</span>
      <span className="border-l border-warn/40 px-2.5 py-1 text-ink-muted">
        {schemeConnectivity.toUpperCase()}
      </span>
    </div>
  );
}
