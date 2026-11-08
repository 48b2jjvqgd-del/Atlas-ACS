import type { ApiError } from '../../lib/api';

export function GatewayUnavailable({ error }: { error: ApiError }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm"
    >
      <p className="font-medium text-danger">{error.message}</p>
      <p className="mt-1 text-ink-muted">
        Start the platform with <code className="font-mono text-ink">pnpm dev:services</code> or{' '}
        <code className="font-mono text-ink">pnpm stack:up</code>. Correlation ID:{' '}
        <code className="font-mono text-ink">{error.correlationId}</code>
      </p>
    </div>
  );
}
