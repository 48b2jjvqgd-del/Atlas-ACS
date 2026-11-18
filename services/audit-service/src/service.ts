import { randomUUID } from 'node:crypto';
import {
  activityRecordedV1,
  auditChainParamsSchema,
  auditQuerySchema,
  tenantParamsSchema,
  type ActivityRecorded,
  type EventEnvelope,
} from '@atlas/contracts';
import { uuidSchema, z } from '@atlas/schemas';
import {
  accessDeniedEntry,
  defineService,
  inScope,
  readPackageVersion,
  scopeFor,
  subscribe,
  systemScope,
  tenantScope,
  type Subscription,
} from '@atlas/service-kit';
import { AtlasError } from '@atlas/shared';
import type { FastifyRequest } from 'fastify';
import { appendRecord, chainOf, findRecord, queryRecords, verifyChain } from './store.js';

/**
 * Audit Service — Stage 1A.
 *
 * Consumes `atlas.platform.activity-recorded.v1` from every producer and stores it append-only
 * with a per-chain hash (see store.ts). Serves the audit trail to authorised users: platform-wide
 * to holders of platform audit.read, per issuer to holders of that issuer's audit.read.
 * There is no update or delete operation anywhere in this service.
 */
const meta = (request: FastifyRequest) => ({
  correlationId: request.correlationId,
  apiVersion: 'v1',
});

export const definition = defineService({
  name: 'audit-service',
  version: readPackageVersion(import.meta.url),
  dependencies: ['postgres', 'rabbitmq'],
  security: {
    verifyTokens: true,
    calls: ['identity-service'],
    // audit-service is the audit store: denials of its own API are written straight into it.
    onDenied: (context) => async (event) => {
      const entry = accessDeniedEntry(event);
      const envelope: EventEnvelope<ActivityRecorded> = {
        specversion: '1.0',
        id: randomUUID(),
        source: 'urn:atlas:service:audit-service',
        type: activityRecordedV1.type,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        dataschema: activityRecordedV1.schemaUri,
        correlationid: event.request.correlationId,
        data: activityRecordedV1.dataSchema.parse({
          ...entry,
          occurredAt: new Date().toISOString(),
        }),
      };
      await inScope(context.infrastructure.postgres!.pool, systemScope, (client) =>
        appendRecord(client, envelope),
      );
    },
  },
  async register(app, context) {
    const pool = context.infrastructure.postgres!.pool;
    const { logger } = context;

    // ---------------------------------------------------------------- consumer
    let subscription: Subscription | undefined;
    let retry: NodeJS.Timeout | undefined;
    const start = () => {
      subscribe({
        connector: context.infrastructure.rabbitmq!,
        service: 'audit-service',
        name: 'activity-recorded',
        contract: activityRecordedV1,
        logger,
        metrics: context.metrics,
        prefetch: 20,
        handler: async (event) => {
          const stored = await inScope(pool, systemScope, (client) => appendRecord(client, event));
          if (!stored) logger.debug({ eventId: event.id }, 'duplicate audit event ignored');
        },
      })
        .then((created) => {
          subscription = created;
          logger.info({ queue: created.queue }, 'audit consumer started');
        })
        .catch((error: unknown) => {
          logger.warn(
            { error: { name: (error as Error).name } },
            'audit consumer could not start; retrying',
          );
          retry = setTimeout(start, 2_000);
          retry.unref();
        });
    };
    start();
    context.readiness.register('audit-consumer', async () => {
      if (!subscription)
        throw Object.assign(new Error('consumer not running'), { code: 'CONSUMER_DOWN' });
    });
    context.onShutdown(async () => {
      clearTimeout(retry);
      await subscription?.cancel();
    });

    // ---------------------------------------------------------------- query API
    app.get(
      '/v1/audit/events',
      {
        schema: { querystring: auditQuerySchema },
        config: { access: { kind: 'user', permission: 'audit.read' } },
      },
      async (request) => {
        const query = request.query as z.infer<typeof auditQuerySchema>;
        const { records, nextBefore } = await inScope(pool, systemScope, (client) =>
          queryRecords(client, query),
        );
        return { data: records, meta: { ...meta(request), nextBefore } };
      },
    );

    app.get(
      '/v1/tenants/:tenantId/audit/events',
      {
        schema: { params: tenantParamsSchema, querystring: auditQuerySchema },
        config: { access: { kind: 'user', permission: 'audit.read', tenantParam: 'tenantId' } },
      },
      async (request) => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const query = request.query as z.infer<typeof auditQuerySchema>;
        const { records, nextBefore } = await inScope(pool, tenantScope(tenantId), (client) =>
          queryRecords(client, { ...query, tenantId }),
        );
        return { data: records, meta: { ...meta(request), nextBefore } };
      },
    );

    app.get(
      '/v1/audit/events/:eventId',
      {
        schema: { params: z.object({ eventId: uuidSchema }) },
        config: { access: { kind: 'user' } },
      },
      async (request) => {
        const { eventId } = request.params as { eventId: string };
        if (!request.authz!.canAnywhere('audit.read')) await request.authorize('audit.read');
        // Row-level security limits the lookup to the issuers the caller may audit.
        const record = await inScope(pool, scopeFor(request.authz!, 'audit.read'), (client) =>
          findRecord(client, eventId),
        );
        if (!record) throw new AtlasError('NOT_FOUND');
        return { data: record, meta: meta(request) };
      },
    );

    app.get(
      '/v1/audit/chains/:chain/verify',
      {
        schema: { params: auditChainParamsSchema },
        config: { access: { kind: 'user', permission: 'audit.verify' } },
      },
      async (request) => {
        const { chain } = request.params as z.infer<typeof auditChainParamsSchema>;
        const result = await inScope(pool, systemScope, (client) =>
          verifyChain(client, chainOf(chain === 'platform' ? null : chain)),
        );
        return {
          data: { chain, ...result, verifiedAt: new Date().toISOString() },
          meta: meta(request),
        };
      },
    );
  },
});
