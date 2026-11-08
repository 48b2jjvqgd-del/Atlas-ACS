import {
  readinessResponseSchema,
  serviceInfoSchema,
  type PlatformServices,
  type ServiceName,
  type ServiceStatus,
} from '@atlas/contracts';
import { createServiceClient } from '@atlas/service-kit';

/**
 * Probes every registered service's /health/ready (and /info for its version) in parallel,
 * each bounded by the configured timeout, and reports what was observed. A slow or dead service
 * degrades only its own row, never the whole response.
 */
export async function collectPlatformHealth(options: {
  urls: Record<ServiceName, string>;
  self: ServiceName;
  timeoutMs: number;
  correlationId: string;
  fetch?: typeof fetch;
}): Promise<PlatformServices> {
  const probes = (Object.entries(options.urls) as [ServiceName, string][]).map(
    async ([service, baseUrl]): Promise<ServiceStatus> => {
      const client = createServiceClient({
        caller: options.self,
        baseUrl,
        timeoutMs: options.timeoutMs,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      try {
        const [readiness, info] = await Promise.all([
          client.get('/health/ready', {
            correlationId: options.correlationId,
            schema: readinessResponseSchema,
            acceptStatus: (status) => status === 200 || status === 503,
          }),
          client
            .get('/info', { correlationId: options.correlationId, schema: serviceInfoSchema })
            .catch(() => undefined),
        ]);
        if (readiness.body.service !== service) {
          // Something else is listening on this service's address.
          return unreachable(service);
        }
        return {
          service,
          status: readiness.body.status,
          version: info?.body.version ?? null,
          latencyMs: readiness.latencyMs,
          checks: readiness.body.checks,
        };
      } catch {
        return unreachable(service);
      }
    },
  );
  return { checkedAt: new Date().toISOString(), services: await Promise.all(probes) };
}

function unreachable(service: ServiceName): ServiceStatus {
  return { service, status: 'unreachable', version: null, latencyMs: null, checks: [] };
}
