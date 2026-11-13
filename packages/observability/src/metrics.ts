import { collectDefaultMetrics, Counter, Histogram, Registry } from '@prometheus-io/client';

/**
 * Prometheus metrics convention.
 *
 * - Each service owns its own registry (no global registry), exposed at GET /metrics.
 * - Metric names are prefixed atlas_ ; every series carries a "service" label.
 * - Labels must be low-cardinality: route templates (/v1/tenants/:tenantId), never raw URLs,
 *   and never tenant IDs, card data or correlation IDs.
 */
export interface ServiceMetrics {
  registry: Registry;
  httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  /** Access-control denials, by reason (forbidden, tenant-not-accessible, ...). */
  accessDenied: Counter<'reason'>;
  /** Events consumed, by event type and outcome (acked, retried, dead-lettered). */
  messagesConsumed: Counter<'event_type' | 'outcome'>;
  /** Outbox relay results, by outcome (published, failed). */
  outboxRelayed: Counter<'outcome'>;
}

export function createServiceMetrics(service: string): ServiceMetrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: 'atlas_' });

  const httpRequestDuration = new Histogram({
    name: 'atlas_http_request_duration_seconds',
    help: 'HTTP request duration in seconds, by route template and status code',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const accessDenied = new Counter({
    name: 'atlas_access_denied_total',
    help: 'Requests denied by access control after authentication, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const messagesConsumed = new Counter({
    name: 'atlas_messages_consumed_total',
    help: 'Events consumed, by event type and outcome (acked, retried, dead-lettered)',
    labelNames: ['event_type', 'outcome'] as const,
    registers: [registry],
  });
  const outboxRelayed = new Counter({
    name: 'atlas_outbox_relayed_total',
    help: 'Transactional outbox relay results, by outcome',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });

  return { registry, httpRequestDuration, accessDenied, messagesConsumed, outboxRelayed };
}
