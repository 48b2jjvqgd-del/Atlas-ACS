import { type PlatformServices, type SuccessEnvelope } from '@atlas/contracts';
import { commaListSchema, positiveIntSchema, z } from '@atlas/schemas';
import { rateLimitDefaults } from '@atlas/security';
import { defineService, readPackageVersion } from '@atlas/service-kit';
import { AtlasError } from '@atlas/shared';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { collectPlatformHealth } from './platform-health.js';
import { resolveServiceUrls } from './registry.js';

/**
 * API Gateway — Stage 0.
 *
 * Edge concerns only: CORS allow-list, rate limiting, and aggregated platform health for the
 * portal. Authentication of portal sessions is added in Stage 1A (see docs/roadmap/ROADMAP.md);
 * until then, nothing behind the gateway exposes tenant data.
 */
export const definition = defineService({
  name: 'api-gateway',
  version: readPackageVersion(import.meta.url),
  dependencies: [],
  configShape: {
    /** Browser origins permitted to call the gateway. Never "*". */
    CORS_ALLOWED_ORIGINS: commaListSchema
      .pipe(z.array(z.url()))
      .default(['http://localhost:5173', 'http://127.0.0.1:5173']),
    /** Resolved service address book; see registry.ts. */
    ATLAS_SERVICE_URLS: z
      .string()
      .optional()
      .transform((value, context) => {
        try {
          return resolveServiceUrls(value);
        } catch (error) {
          context.addIssue({ code: 'custom', message: (error as Error).message });
          return z.NEVER;
        }
      }),
    HEALTH_PROBE_TIMEOUT_MS: positiveIntSchema.default(1_500),
    RATE_LIMIT_MAX: positiveIntSchema.default(rateLimitDefaults.portal.max),
  },
  async register(app, { config, metadata }) {
    await app.register(cors, {
      origin: config.CORS_ALLOWED_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      exposedHeaders: ['x-correlation-id', 'x-request-id'],
      maxAge: 600,
    });

    // Registered after the infrastructure endpoints, so orchestrator probes are never limited.
    await app.register(rateLimit, {
      max: config.RATE_LIMIT_MAX,
      timeWindow: rateLimitDefaults.portal.timeWindowMs,
      errorResponseBuilder: (_request, context) =>
        new AtlasError('RATE_LIMITED', { detail: `Retry after ${Math.ceil(context.ttl / 1000)}s` }),
    });

    // The plugin only covers registered routes; limit unmatched paths too, so path scanning
    // against the edge is throttled like any other traffic.
    const limitUnmatched = app.rateLimit();
    app.addHook('onRequest', async function (request, reply) {
      if (request.is404) await limitUnmatched.call(this, request, reply);
    });

    app.get(
      '/v1/platform/services',
      {
        config: {
          rateLimit: {
            max: rateLimitDefaults.healthAggregation.max,
            timeWindow: rateLimitDefaults.healthAggregation.timeWindowMs,
          },
        },
      },
      async (request): Promise<SuccessEnvelope<PlatformServices>> => {
        const data = await collectPlatformHealth({
          urls: config.ATLAS_SERVICE_URLS,
          self: metadata.name,
          timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
          correlationId: request.correlationId,
        });
        return { data, meta: { correlationId: request.correlationId, apiVersion: 'v1' } };
      },
    );
  },
});
