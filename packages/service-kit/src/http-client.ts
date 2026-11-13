import { headers, problemDetailsSchema, type ServiceName } from '@atlas/contracts';
import type { z } from '@atlas/schemas';
import { AtlasError, type ErrorCode } from '@atlas/shared';
import type { ServiceTokenProvider } from './auth/service-tokens.js';

/**
 * Synchronous service-to-service HTTP conventions.
 *
 * - Every call has an explicit timeout; there is no unbounded wait on another service.
 * - Every call is authenticated with a service token for exactly the callee (Stage 1A), and the
 *   caller's correlation ID is always propagated. x-atlas-caller remains for diagnostics only.
 * - Calls made on a user's behalf forward the user's token; the callee verifies it independently.
 * - 2xx responses are validated against the callee's published contract when a schema is given.
 * - No automatic retries: retries on the authentication path multiply latency and load.
 *   Callers decide explicitly, and only for idempotent operations.
 * - Upstream 4xx problems are passed through with their status and code (so a 404 from the owner
 *   stays a 404); upstream 5xx and transport failures become DEPENDENCY_UNAVAILABLE / timeouts.
 */
export interface ServiceClientOptions {
  caller: ServiceName;
  /** The service being called; selects the token audience. */
  callee?: ServiceName;
  baseUrl: string;
  timeoutMs: number;
  tokens?: ServiceTokenProvider;
  fetch?: typeof fetch;
}

export interface ServiceResponse<T> {
  status: number;
  body: T;
  latencyMs: number;
}

export interface ServiceRequest<T> {
  correlationId: string;
  /** Validate a 2xx response body. */
  schema?: z.ZodType<T>;
  /** Statuses treated as a normal response. Default: 2xx only. */
  acceptStatus?: (status: number) => boolean;
  /** End-user token to forward (calls on a user's behalf). */
  userToken?: string;
  /** JSON request body. */
  body?: unknown;
  /** Extra request headers (non-sensitive). */
  headers?: Record<string, string>;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const passThroughCodes = new Set<ErrorCode>([
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
]);

export function createServiceClient(options: ServiceClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');

  async function execute<T>(
    method: Method,
    path: string,
    request: ServiceRequest<T>,
    retried = false,
  ): Promise<ServiceResponse<T>> {
    const started = performance.now();
    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
      [headers.correlationId]: request.correlationId,
      [headers.caller]: options.caller,
      ...request.headers,
    };
    if (options.tokens && options.callee) {
      requestHeaders[headers.authorization] =
        `Bearer ${await options.tokens.token(options.callee)}`;
    }
    if (request.userToken) requestHeaders[headers.userToken] = request.userToken;
    if (request.body !== undefined) requestHeaders['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: requestHeaders,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error).name === 'TimeoutError';
      throw new AtlasError(timedOut ? 'UPSTREAM_TIMEOUT' : 'DEPENDENCY_UNAVAILABLE', {
        cause: error,
      });
    }
    // A cached service token can outlive the provider's signing key (e.g. after a key change):
    // when the callee rejects our own credentials, fetch a new token once and retry.
    if (response.status === 401 && !retried && options.tokens?.invalidate && options.callee) {
      const problem = problemDetailsSchema.safeParse(
        await response
          .clone()
          .json()
          .catch(() => undefined),
      );
      if (problem.success && problem.data.detail !== 'User token required') {
        options.tokens.invalidate(options.callee);
        return execute(method, path, request, true);
      }
    }
    const latencyMs = Math.round((performance.now() - started) * 100) / 100;
    const accept = request.acceptStatus ?? ((status: number) => status >= 200 && status < 300);
    const payload: unknown =
      response.status === 204 ? undefined : await response.json().catch(() => undefined);

    if (!accept(response.status)) {
      const problem = problemDetailsSchema.safeParse(payload);
      if (problem.success && response.status < 500 && passThroughCodes.has(problem.data.code)) {
        throw new AtlasError(problem.data.code, {
          ...(problem.data.detail ? { detail: problem.data.detail } : {}),
          ...(problem.data.issues ? { details: { issues: problem.data.issues } } : {}),
        });
      }
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: `Upstream responded ${response.status}${problem.success ? ` (${problem.data.code})` : ''}`,
      });
    }
    if (request.schema && response.status >= 200 && response.status < 300) {
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

  return {
    get: <T>(path: string, r: ServiceRequest<T>) => execute<T>('GET', path, r),
    post: <T>(path: string, r: ServiceRequest<T>) => execute<T>('POST', path, r),
    put: <T>(path: string, r: ServiceRequest<T>) => execute<T>('PUT', path, r),
    patch: <T>(path: string, r: ServiceRequest<T>) => execute<T>('PATCH', path, r),
    delete: <T>(path: string, r: ServiceRequest<T>) => execute<T>('DELETE', path, r),
  };
}

export type ServiceClient = ReturnType<typeof createServiceClient>;
