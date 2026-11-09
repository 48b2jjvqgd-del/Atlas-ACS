import {
  changeTenantStatusBodySchema,
  createTenantBodySchema,
  issuerSettingsSchema,
  listTenantsQuerySchema,
  putTenantConfigurationBodySchema,
  tenantCreatedV1,
  tenantParamsSchema,
  tenantStatusTransitions,
  updateTenantBodySchema,
  type SuccessEnvelope,
  type TenantConfiguration,
  type TenantSummary,
} from '@atlas/contracts';
import { positiveIntSchema, type z } from '@atlas/schemas';
import {
  accessDeniedEntry,
  buildEnvelope,
  createAuditWriter,
  defineService,
  diffFields,
  enqueueEvent,
  EventPublisher,
  inScope,
  isUniqueViolation,
  OutboxRelay,
  readPackageVersion,
  scopeFor,
  systemScope,
  tenantScope,
} from '@atlas/service-kit';
import { AtlasError } from '@atlas/shared';
import type { FastifyRequest } from 'fastify';
import * as repo from './repository.js';

/**
 * Issuer Service — Stage 1A.
 *
 * The issuer (tenant) registry: profiles, lifecycle and versioned configuration. Every change is
 * audited inside the same transaction (transactional outbox). Access is decided per request from
 * the caller's verified principal; row-level security backs that up in the database.
 */
const meta = (request: FastifyRequest) => ({
  correlationId: request.correlationId,
  apiVersion: 'v1',
});
const audit = createAuditWriter({ service: 'issuer-service', schema: 'issuer' });

/** Fields recorded with before/after values in the audit trail (non-sensitive by design). */
const profileAuditFields = ['displayName', 'internalReference', 'status'] as const;
const settingsAuditFields = [
  'timezone',
  'defaultLocale',
  'supportContactEmail',
  'supportContactPhone',
  'schemeParticipation.visa',
  'schemeParticipation.mastercard',
  'branding.primaryColour',
] as const;

const actor = (request: FastifyRequest) => ({
  type: 'user' as const,
  id: request.principal!.userId,
  displayName: request.principal!.displayName,
});

export const definition = defineService({
  name: 'issuer-service',
  version: readPackageVersion(import.meta.url),
  dependencies: ['postgres', 'rabbitmq'],
  configShape: { OUTBOX_RELAY_INTERVAL_MS: positiveIntSchema.default(250) },
  security: {
    verifyTokens: true,
    calls: ['identity-service'],
    onDenied: (context) => async (event) => {
      await audit.recordDetached(
        context.infrastructure.postgres!.pool,
        event.request.correlationId,
        accessDeniedEntry(event),
      );
    },
  },
  async register(app, context) {
    const pool = context.infrastructure.postgres!.pool;
    const publisher = new EventPublisher(context.infrastructure.rabbitmq!, 'issuer-service', {
      logger: context.logger,
    });
    const relay = new OutboxRelay({
      pool,
      schema: 'issuer',
      publisher,
      logger: context.logger,
      metrics: context.metrics,
      intervalMs: context.config.OUTBOX_RELAY_INTERVAL_MS,
    });
    relay.start();
    context.onShutdown(() => relay.stop());

    // ---------------------------------------------------------------- registry
    app.get(
      '/v1/tenants',
      { schema: { querystring: listTenantsQuerySchema }, config: { access: { kind: 'user' } } },
      async (request) => {
        const query = request.query as z.infer<typeof listTenantsQuerySchema>;
        // The caller sees exactly the issuers on which they hold issuer.read.
        const scope = scopeFor(request.authz!, 'issuer.read');
        const { rows, total } = await inScope(pool, scope, (client) =>
          repo.listTenants(client, query),
        );
        return {
          data: rows,
          meta: { ...meta(request), total, limit: query.limit, offset: query.offset },
        };
      },
    );

    app.post(
      '/v1/tenants',
      {
        schema: { body: createTenantBodySchema },
        config: { access: { kind: 'user', permission: 'issuer.create' } },
      },
      async (request, reply): Promise<SuccessEnvelope<TenantSummary>> => {
        const body = request.body as z.infer<typeof createTenantBodySchema>;
        const settings = issuerSettingsSchema.parse(body.settings ?? {});
        const tenant = await inScope(pool, systemScope, async (client) => {
          let created: TenantSummary;
          try {
            created = await repo.insertTenant(client, {
              slug: body.slug,
              displayName: body.displayName,
              internalReference: body.internalReference,
              // Outside controlled environments every issuer is synthetic by definition.
              isSynthetic: !['staging', 'production'].includes(context.config.ATLAS_ENV),
            });
          } catch (error) {
            if (isUniqueViolation(error, 'tenant_slug_key')) {
              throw new AtlasError('CONFLICT', {
                detail: 'An issuer with this slug already exists',
              });
            }
            if (isUniqueViolation(error, 'tenant_internal_reference_key')) {
              throw new AtlasError('CONFLICT', {
                detail: 'An issuer with this internal reference already exists',
              });
            }
            throw error;
          }
          await repo.insertConfiguration(
            client,
            created.id,
            1,
            settings,
            request.principal!.userId,
          );
          await audit.record(client, request.correlationId, {
            actor: actor(request),
            tenantId: created.id,
            action: 'issuer.created',
            resource: { type: 'issuer', id: created.id, name: created.displayName },
            outcome: 'success',
            changes: [
              ...diffFields(null, created, profileAuditFields),
              { field: 'slug', before: null, after: created.slug },
            ],
          });
          await enqueueEvent(
            client,
            'issuer',
            buildEnvelope(
              tenantCreatedV1,
              { tenantId: created.id, slug: created.slug, displayName: created.displayName },
              {
                service: 'issuer-service',
                correlationId: request.correlationId,
                tenantId: created.id,
              },
            ),
          );
          return created;
        });
        reply.status(201);
        return { data: tenant, meta: meta(request) };
      },
    );

    app.get(
      '/v1/tenants/:tenantId',
      {
        schema: { params: tenantParamsSchema },
        config: { access: { kind: 'user', permission: 'issuer.read', tenantParam: 'tenantId' } },
      },
      async (request): Promise<SuccessEnvelope<TenantSummary>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const tenant = await inScope(pool, tenantScope(tenantId), (client) =>
          repo.findTenant(client, tenantId),
        );
        if (!tenant) throw new AtlasError('NOT_FOUND');
        return { data: tenant, meta: meta(request) };
      },
    );

    app.patch(
      '/v1/tenants/:tenantId',
      {
        schema: { params: tenantParamsSchema, body: updateTenantBodySchema },
        config: { access: { kind: 'user', permission: 'issuer.update', tenantParam: 'tenantId' } },
      },
      async (request): Promise<SuccessEnvelope<TenantSummary>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const body = request.body as z.infer<typeof updateTenantBodySchema>;
        const tenant = await inScope(pool, tenantScope(tenantId), async (client) => {
          const before = await repo.findTenant(client, tenantId, true);
          if (!before) throw new AtlasError('NOT_FOUND');
          if (before.status === 'offboarded') {
            throw new AtlasError('CONFLICT', { detail: 'An offboarded issuer cannot be changed' });
          }
          let after: TenantSummary;
          try {
            after = await repo.updateTenant(client, tenantId, body);
          } catch (error) {
            if (isUniqueViolation(error, 'tenant_internal_reference_key')) {
              throw new AtlasError('CONFLICT', {
                detail: 'An issuer with this internal reference already exists',
              });
            }
            throw error;
          }
          const changes = diffFields(before, after, profileAuditFields);
          if (changes.length > 0) {
            await audit.record(client, request.correlationId, {
              actor: actor(request),
              tenantId,
              action: 'issuer.updated',
              resource: { type: 'issuer', id: tenantId, name: after.displayName },
              outcome: 'success',
              changes,
            });
          }
          return after;
        });
        return { data: tenant, meta: meta(request) };
      },
    );

    app.post(
      '/v1/tenants/:tenantId/status',
      {
        schema: { params: tenantParamsSchema, body: changeTenantStatusBodySchema },
        config: {
          access: { kind: 'user', permission: 'issuer.status.manage', tenantParam: 'tenantId' },
        },
      },
      async (request): Promise<SuccessEnvelope<TenantSummary>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const body = request.body as z.infer<typeof changeTenantStatusBodySchema>;
        const tenant = await inScope(pool, tenantScope(tenantId), async (client) => {
          const before = await repo.findTenant(client, tenantId, true);
          if (!before) throw new AtlasError('NOT_FOUND');
          if (!tenantStatusTransitions[before.status].includes(body.status)) {
            throw new AtlasError('CONFLICT', {
              detail: `An issuer cannot move from ${before.status} to ${body.status}`,
            });
          }
          const after = await repo.updateTenant(client, tenantId, { status: body.status });
          const action =
            body.status === 'active'
              ? 'issuer.activated'
              : body.status === 'suspended'
                ? 'issuer.suspended'
                : 'issuer.offboarded';
          await audit.record(client, request.correlationId, {
            actor: actor(request),
            tenantId,
            action,
            resource: { type: 'issuer', id: tenantId, name: after.displayName },
            outcome: 'success',
            changes: [{ field: 'status', before: before.status, after: after.status }],
            reason: body.reason,
          });
          return after;
        });
        return { data: tenant, meta: meta(request) };
      },
    );

    // ---------------------------------------------------------------- configuration
    app.get(
      '/v1/tenants/:tenantId/configuration',
      {
        schema: { params: tenantParamsSchema },
        config: {
          access: {
            kind: 'user',
            permission: 'issuer.configuration.read',
            tenantParam: 'tenantId',
          },
        },
      },
      async (request): Promise<SuccessEnvelope<TenantConfiguration>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const configuration = await inScope(pool, tenantScope(tenantId), (client) =>
          repo.currentConfiguration(client, tenantId),
        );
        if (!configuration) throw new AtlasError('NOT_FOUND');
        return { data: configuration, meta: meta(request) };
      },
    );

    app.put(
      '/v1/tenants/:tenantId/configuration',
      {
        schema: { params: tenantParamsSchema, body: putTenantConfigurationBodySchema },
        config: {
          access: {
            kind: 'user',
            permission: 'issuer.configuration.manage',
            tenantParam: 'tenantId',
          },
          // Sensitive configuration change: the gateway applies its tighter rate limit.
        },
      },
      async (request): Promise<SuccessEnvelope<TenantConfiguration>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const body = request.body as z.infer<typeof putTenantConfigurationBodySchema>;
        const configuration = await inScope(pool, tenantScope(tenantId), async (client) => {
          const tenant = await repo.findTenant(client, tenantId, true);
          if (!tenant) throw new AtlasError('NOT_FOUND');
          if (tenant.status === 'offboarded') {
            throw new AtlasError('CONFLICT', {
              detail: 'An offboarded issuer cannot be reconfigured',
            });
          }
          const current = await repo.currentConfiguration(client, tenantId);
          const currentVersion = current?.version ?? 0;
          if (body.expectedVersion !== currentVersion) {
            throw new AtlasError('CONFLICT', {
              detail: `Configuration has changed (now version ${currentVersion}); reload and try again`,
            });
          }
          const changes = diffFields(current?.settings ?? null, body.settings, settingsAuditFields);
          if (changes.length === 0 && current) return current;
          const next = await repo.insertConfiguration(
            client,
            tenantId,
            currentVersion + 1,
            body.settings,
            request.principal!.userId,
          );
          await audit.record(client, request.correlationId, {
            actor: actor(request),
            tenantId,
            action: 'issuer.configuration.updated',
            resource: { type: 'issuer-configuration', id: tenantId, name: tenant.displayName },
            outcome: 'success',
            changes: changes.map((change) => ({ ...change, field: `settings.${change.field}` })),
            metadata: { version: next.version },
          });
          return next;
        });
        return { data: configuration, meta: meta(request) };
      },
    );

    // ---------------------------------------------------------------- service-only
    app.get(
      '/v1/internal/tenants/:tenantId',
      {
        schema: { params: tenantParamsSchema },
        config: { access: { kind: 'service', callers: ['identity-service'] } },
      },
      async (request): Promise<SuccessEnvelope<TenantSummary>> => {
        const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
        const tenant = await inScope(pool, systemScope, (client) =>
          repo.findTenant(client, tenantId),
        );
        if (!tenant) throw new AtlasError('NOT_FOUND');
        return { data: tenant, meta: meta(request) };
      },
    );
  },
});
