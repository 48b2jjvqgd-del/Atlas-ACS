import { headers, problemDetailsSchema, type ServiceName } from '@atlas/contracts';
import type { z } from '@atlas/schemas';
import { AtlasError } from '@atlas/shared';

/**
 * Synchronous service-to-service HTTP conventions.
 *
 * - Every call has an explicit timeout; there is no unbounded wait on another service.
 * - The caller's correlation ID is always propagated; the caller identifies itself with
 *   x-atlas-caller (identification only — not authentication; see SECURITY_MODEL.md).
 * - Responses are validated against the callee's published contract when a schema is given.
 * - No automatic retries: retries on the authentication path multiply latency and load.
 *   Callers decide explicitly, and only for idempotent operations.
 */
export interface ServiceClientOptions {
  caller: ServiceName;
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export interface ServiceResponse<T> {
  status: number;
  body: T;
  latencyMs: number;
}

export interface ServiceRequest<T> {
  correlationId: string;
  /** Validate the response body. Applied to any status unless `acceptStatus` excludes it. */
  schema?: z.ZodType<T>;
  /** Statuses treated as a contract-conformant response. Default: 2xx only. */
  acceptStatus?: (status: number) => boolean;
}

export function createServiceClient(options: ServiceClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function get<T>(path: string, request: ServiceRequest<T>): Promise<ServiceResponse<T>> {
    const started = performance.now();
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [headers.correlationId]: request.correlationId,
          [headers.caller]: options.caller,
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new AtlasError(timedOut ? 'UPSTREAM_TIMEOUT' : 'DEPENDENCY_UNAVAILABLE', {
        cause: error,
      });
    }
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const accept = request.acceptStatus ?? ((status: number) => status >= 200 && status < 300);
    const payload: unknown = await response.json().catch(() => undefined);

    if (!accept(response.status)) {
      const problem = problemDetailsSchema.safeParse(payload);
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: `Upstream responded ${response.status}${problem.success ? ` (${problem.data.code})` : ''}`,
      });
    }
    if (request.schema) {
      const parsed = request.schema.safeParse(payload);
      if (!parsed.success) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: 'Upstream response violated its contract',
        });
      }
      return { status: response.status, body: parsed.data, latencyMs };
    }
    return { status: response.status, body: payload as T, latencyMs };
  }

  return { get };
}

export type ServiceClient = ReturnType<typeof createServiceClient>;
