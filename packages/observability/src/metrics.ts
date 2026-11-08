import { collectDefaultMetrics, Histogram, Registry } from '@prometheus-io/client';

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

  return { registry, httpRequestDuration };
}
