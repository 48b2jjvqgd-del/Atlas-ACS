/**
 * Secure HTTP defaults applied by every ATLAS service.
 */

/** Maximum accepted request body. EMV 3DS messages are small; raise per-route only with reason. */
export const DEFAULT_BODY_LIMIT_BYTES = 256 * 1024;

/** Server-side timeouts that bound slow-client resource consumption. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;

/**
 * Security headers for JSON APIs (applied via @fastify/helmet). APIs never serve active content,
 * so the content security policy denies everything.
 */
export const apiHelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
  },
  crossOriginResourcePolicy: { policy: 'same-site' as const },
  referrerPolicy: { policy: 'no-referrer' as const },
  hsts: { maxAge: 31_536_000, includeSubDomains: true },
};

/**
 * Rate-limit conventions. Limits are applied at the edge (api-gateway) per client identity;
 * internal services rely on the gateway plus their own bounded concurrency. In Stage 0 the
 * counter store is in-memory; a shared Valkey store is required before horizontal scaling.
 */
export const rateLimitDefaults = {
  /** Portal and administrative APIs, per client per window. */
  portal: { max: 300, timeWindowMs: 60_000 },
  /** Health aggregation endpoint: cheap to abuse as an amplifier, so tighter. */
  healthAggregation: { max: 60, timeWindowMs: 60_000 },
} as const;
