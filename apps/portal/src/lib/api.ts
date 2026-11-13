import {
  csrfHeader,
  platformServicesResponseSchema,
  problemDetailsSchema,
  type PlatformServices,
  type ValidationIssue,
} from '@atlas/contracts';
import type { z } from '@atlas/schemas';

/**
 * Portal API client.
 *
 * All calls go to the same-origin /api prefix (Vite proxy in development, nginx in containers)
 * with the session cookie, carry a fresh correlation ID, send the session's CSRF token on writes,
 * and validate responses against the published contracts so contract drift is caught immediately
 * rather than rendered wrongly. The browser never sees an access token.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'problem' | 'contract',
    readonly correlationId: string,
    readonly code?: string,
    readonly status?: number,
    readonly issues?: ValidationIssue[],
  ) {
    super(message);
  }
}

let csrfToken: string | undefined;
let onUnauthenticated: ((message: string) => void) | undefined;

/** Set by the session provider. */
export function configureApi(options: {
  csrfToken?: string;
  onUnauthenticated?: (message: string) => void;
}) {
  csrfToken = options.csrfToken;
  if (options.onUnauthenticated) onUnauthenticated = options.onUnauthenticated;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function apiRequest<T>(
  method: Method,
  path: string,
  options: {
    body?: unknown;
    schema?: z.ZodType<T>;
    signal?: AbortSignal;
    quietUnauthenticated?: boolean;
  } = {},
): Promise<{ body: T; correlationId: string; status: number }> {
  const correlationId = crypto.randomUUID();
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-correlation-id': correlationId,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[csrfHeader] = csrfToken;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: options.signal ?? AbortSignal.timeout(12_000),
    });
  } catch {
    throw new ApiError('The ATLAS gateway could not be reached.', 'unreachable', correlationId);
  }
  const body: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(body);
    if (problem.success) {
      const message = problem.data.detail ?? problem.data.title;
      if (response.status === 401 && !options.quietUnauthenticated) onUnauthenticated?.(message);
      throw new ApiError(
        message,
        'problem',
        problem.data.correlationId,
        problem.data.code,
        response.status,
        problem.data.issues,
      );
    }
    // A proxy error page (e.g. gateway not running behind the dev proxy) is not a problem document.
    throw new ApiError(
      'The ATLAS gateway could not be reached.',
      'unreachable',
      correlationId,
      undefined,
      response.status,
    );
  }
  if (options.schema) {
    const parsed = options.schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        'The response did not match the published contract.',
        'contract',
        correlationId,
      );
    }
    return { body: parsed.data, correlationId, status: response.status };
  }
  return { body: body as T, correlationId, status: response.status };
}

export const api = {
  get: <T>(path: string, schema?: z.ZodType<T>, signal?: AbortSignal) =>
    apiRequest<T>('GET', path, {
      ...(schema ? { schema } : {}),
      ...(signal ? { signal } : {}),
    }).then((r) => r.body),
  post: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) =>
    apiRequest<T>('POST', path, { body, ...(schema ? { schema } : {}) }).then((r) => r.body),
  put: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) =>
    apiRequest<T>('PUT', path, { body, ...(schema ? { schema } : {}) }).then((r) => r.body),
  patch: <T>(path: string, body?: unknown, schema?: z.ZodType<T>) =>
    apiRequest<T>('PATCH', path, { body, ...(schema ? { schema } : {}) }).then((r) => r.body),
  delete: (path: string) => apiRequest<undefined>('DELETE', path).then(() => undefined),
};

export async function fetchPlatformServices(): Promise<PlatformServices> {
  return (await api.get('/v1/platform/services', platformServicesResponseSchema)).data;
}

/** A short, user-facing explanation of an error, with the reference support needs. */
export function describeError(error: unknown): {
  title: string;
  detail: string;
  reference?: string;
} {
  if (error instanceof ApiError) {
    const titles: Record<string, string> = {
      FORBIDDEN: 'Not permitted',
      NOT_FOUND: 'Not found',
      CONFLICT: 'Could not complete the change',
      VALIDATION_FAILED: 'Please check the form',
      RATE_LIMITED: 'Too many requests',
      UNAUTHENTICATED: 'Signed out',
    };
    return {
      title:
        (error.code && titles[error.code]) ??
        (error.kind === 'unreachable' ? 'Service unavailable' : 'Something went wrong'),
      detail: error.message,
      reference: error.correlationId,
    };
  }
  return { title: 'Something went wrong', detail: 'An unexpected error occurred.' };
}
