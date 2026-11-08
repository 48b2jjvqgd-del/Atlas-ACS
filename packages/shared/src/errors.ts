/**
 * ATLAS platform error model.
 *
 * Error codes are part of the public API contract: they are stable, machine-readable and
 * versioned with the API. Never reuse a code for a different meaning; add a new code instead.
 */
export const errorCodes = {
  VALIDATION_FAILED: { status: 400, title: 'Request validation failed' },
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  FORBIDDEN: { status: 403, title: 'Access denied' },
  NOT_FOUND: { status: 404, title: 'Resource not found' },
  METHOD_NOT_ALLOWED: { status: 405, title: 'Method not allowed' },
  CONFLICT: { status: 409, title: 'Conflict' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  DEPENDENCY_UNAVAILABLE: { status: 503, title: 'A required dependency is unavailable' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
  UPSTREAM_TIMEOUT: { status: 504, title: 'Upstream service timed out' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ErrorCode = keyof typeof errorCodes;

export const errorCodeList = Object.keys(errorCodes) as [ErrorCode, ...ErrorCode[]];

export interface AtlasErrorOptions {
  /** Safe, client-facing detail. Must never contain secrets or cardholder data. */
  detail?: string;
  /** Structured, client-safe supplementary information (e.g. validation issues). */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * The only error type that services should deliberately throw to signal an API error.
 * Anything else reaching the error handler is treated as an unexpected INTERNAL_ERROR and
 * its message is not exposed to the client.
 */
export class AtlasError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, options: AtlasErrorOptions = {}) {
    super(options.detail ?? errorCodes[code].title, { cause: options.cause });
    this.name = 'AtlasError';
    this.code = code;
    this.status = errorCodes[code].status;
    this.detail = options.detail;
    this.details = options.details;
  }
}

export function isAtlasError(value: unknown): value is AtlasError {
  return value instanceof AtlasError;
}

/** Raised when service configuration is invalid. Messages name keys, never values. */
export class ConfigurationError extends Error {
  readonly issues: readonly { key: string; message: string }[];

  constructor(issues: readonly { key: string; message: string }[]) {
    super(
      `Invalid configuration: ${issues.map((issue) => `${issue.key} (${issue.message})`).join('; ')}`,
    );
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}
