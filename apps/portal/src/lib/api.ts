import {
  platformServicesResponseSchema,
  problemDetailsSchema,
  type PlatformServices,
} from '@atlas/contracts';

/**
 * Portal API client. All calls go to the same-origin /api prefix (Vite proxy in development,
 * nginx in containers), carry a fresh correlation ID, and validate responses against the
 * published contracts so contract drift is caught immediately rather than rendered wrongly.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'problem' | 'contract',
    readonly correlationId: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function getJson(path: string): Promise<{ body: unknown; correlationId: string }> {
  const correlationId = crypto.randomUUID();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      headers: { accept: 'application/json', 'x-correlation-id': correlationId },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError('The API gateway could not be reached.', 'unreachable', correlationId);
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(body);
    if (problem.success) {
      throw new ApiError(
        problem.data.detail ?? problem.data.title,
        'problem',
        correlationId,
        problem.data.code,
      );
    }
    // A proxy error page (e.g. gateway not running behind the dev proxy) is not a problem document.
    throw new ApiError('The API gateway could not be reached.', 'unreachable', correlationId);
  }
  return { body, correlationId };
}

export async function fetchPlatformServices(): Promise<PlatformServices> {
  const { body, correlationId } = await getJson('/v1/platform/services');
  const parsed = platformServicesResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      'The gateway response did not match the published contract.',
      'contract',
      correlationId,
    );
  }
  return parsed.data.data;
}
