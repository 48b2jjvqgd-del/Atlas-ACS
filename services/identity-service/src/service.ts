import {
  createRoleBodySchema,
  inviteUserBodySchema,
  permissionCatalog,
  permissionKeys,
  permissionAllowsScope,
  roleParamsSchema,
  setRolesBodySchema,
  setUserStatusBodySchema,
  subjectParamsSchema,
  tenantParamsSchema,
  tenantSummarySchema,
  tenantUserParamsSchema,
  updateRoleBodySchema,
  userParamsSchema,
  successEnvelope,
  type Principal,
  type SuccessEnvelope,
} from '@atlas/contracts';
import { booleanStringSchema, positiveIntSchema, z } from '@atlas/schemas';
import {
  accessDeniedEntry,
  createAuditWriter,
  defineService,
  diffFields,
  EventPublisher,
  inScope,
  isUniqueViolation,
  OutboxRelay,
  readPackageVersion,
  systemScope,
  tenantScope,
  type PrincipalResolver,
} from '@atlas/service-kit';
import { AtlasError } from '@atlas/shared';
import type { FastifyRequest } from 'fastify';
import { createKeycloakAdmin, splitName, type IdentityProviderAdmin } from './identity-provider.js';
import { startIdpEventIngestion } from './idp-events.js';
import * as repo from './repository.js';

/**
 * Identity Service — Stage 1A.
 *
 * System of record for ATLAS users, roles, permissions and issuer memberships. The identity
 * provider (Keycloak locally) authenticates people; this service decides what they may do.
 * See docs/security/SECURITY_MODEL.md ("Authentication and authorisation").
 */
const meta = (request: FastifyRequest) => ({
  correlationId: request.correlationId,
  apiVersion: 'v1',
});

const audit = createAuditWriter({ service: 'identity-service', schema: 'identity' });

export interface IdentityServiceDependencies {
  /** Replace the identity-provider admin client (tests). */
  identityProvider?: IdentityProviderAdmin | null;
}

const configShape = {
  /** Provision accounts at the identity provider when inviting users. */
  IDP_ADMIN_ENABLED: booleanStringSchema.default(true),
  /** How often to ingest failed sign-ins from the provider; 0 disables. */
  IDP_EVENT_POLL_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  OUTBOX_RELAY_INTERVAL_MS: positiveIntSchema.default(250),
};

function localPrincipals(context: {
  infrastructure: { postgres?: { pool: import('pg').Pool } };
}): PrincipalResolver {
  return {
    async resolve(subject) {
      const pool = context.infrastructure.postgres!.pool;
      return inScope(pool, systemScope, (client) => repo.resolvePrincipal(client, subject));
    },
  };
}

export function createIdentityService(dependencies: IdentityServiceDependencies = {}) {
  return defineService({
    name: 'identity-service',
    version: readPackageVersion(import.meta.url),
    dependencies: ['postgres', 'rabbitmq'],
    configShape,
    security: {
      verifyTokens: true,
      calls: ['issuer-service'],
      principals: (context) => localPrincipals(context),
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
      const issuer = context.clients['issuer-service']!;
      const { config, logger } = context;

      const idp: IdentityProviderAdmin | null =
        dependencies.identityProvider !== undefined
          ? dependencies.identityProvider
          : config.IDP_ADMIN_ENABLED && config.SERVICE_CLIENT_SECRET
            ? createKeycloakAdmin({
                issuerBase: (config.OIDC_INTERNAL_URL ?? config.OIDC_ISSUER_URL)!,
                clientId: 'atlas-svc-identity-service',
                clientSecret: config.SERVICE_CLIENT_SECRET,
              })
            : null;

      // ---- Background work: outbox relay, system-role synchronisation, IdP event ingestion
      const publisher = new EventPublisher(context.infrastructure.rabbitmq!, 'identity-service', {
        logger,
      });
      const relay = new OutboxRelay({
        pool,
        schema: 'identity',
        publisher,
        logger,
        metrics: context.metrics,
        intervalMs: config.OUTBOX_RELAY_INTERVAL_MS,
      });
      relay.start();
      context.onShutdown(() => relay.stop());

      const syncRoles = async () => {
        await inScope(pool, systemScope, async (client) => {
          const changed = await repo.synchroniseSystemRoles(client);
          for (const change of changed) {
            await audit.record(client, `system-sync-${Date.now()}`, {
              actor: { type: 'system', id: 'identity-service' },
              action: 'role.permissions.synchronised',
              resource: { type: 'role', id: change.key },
              outcome: 'success',
              changes: [
                {
                  field: 'permissions',
                  before: change.before.join(' '),
                  after: change.after.join(' '),
                },
              ],
              reason: 'System role definitions synchronised from the permission catalogue',
            });
          }
          if (changed.length > 0)
            logger.info({ roles: changed.map((c) => c.key) }, 'system roles synchronised');
        });
      };
      let syncTimer: NodeJS.Timeout | undefined;
      const trySync = () => {
        syncRoles().catch(() => {
          syncTimer = setTimeout(trySync, 5_000);
          syncTimer.unref();
        });
      };
      trySync();
      context.onShutdown(async () => clearTimeout(syncTimer));

      if (idp && config.IDP_EVENT_POLL_INTERVAL_MS > 0) {
        const stop = startIdpEventIngestion({
          pool,
          idp,
          logger,
          audit,
          intervalMs: config.IDP_EVENT_POLL_INTERVAL_MS,
        });
        context.onShutdown(stop);
      }

      const actorId = (request: FastifyRequest) => request.principal!.userId;

      // ---------------------------------------------------------- service-only
      app.get(
        '/v1/internal/principals/:subject',
        {
          schema: { params: subjectParamsSchema },
          config: {
            access: {
              kind: 'service',
              callers: ['api-gateway', 'issuer-service', 'audit-service'],
            },
          },
        },
        async (request, reply): Promise<SuccessEnvelope<Principal>> => {
          const { subject } = request.params as z.infer<typeof subjectParamsSchema>;
          const principal = await inScope(pool, systemScope, (client) =>
            repo.resolvePrincipal(client, subject),
          );
          if (!principal) {
            reply.status(404);
            throw new AtlasError('NOT_FOUND', { detail: 'No ATLAS account for this subject' });
          }
          return { data: principal, meta: meta(request) };
        },
      );

      app.post(
        '/v1/internal/principals/:subject/sign-ins',
        {
          schema: { params: subjectParamsSchema },
          config: { access: { kind: 'service', callers: ['api-gateway'] } },
        },
        async (request): Promise<SuccessEnvelope<Principal>> => {
          const { subject } = request.params as z.infer<typeof subjectParamsSchema>;
          const principal = await inScope(pool, systemScope, async (client) => {
            await repo.recordSignIn(client, subject);
            return repo.resolvePrincipal(client, subject);
          });
          if (!principal)
            throw new AtlasError('NOT_FOUND', { detail: 'No ATLAS account for this subject' });
          return { data: principal, meta: meta(request) };
        },
      );

      // ---------------------------------------------------------- the caller
      app.get('/v1/identity/me', { config: { access: { kind: 'user' } } }, async (request) => ({
        data: request.principal!,
        meta: meta(request),
      }));

      app.get(
        '/v1/identity/permissions',
        { config: { access: { kind: 'user' } } },
        async (request) => ({
          data: permissionKeys.map((key) => ({
            key,
            description: permissionCatalog[key].description,
            category: permissionCatalog[key].category,
            scopes: [...permissionCatalog[key].scopes],
          })),
          meta: meta(request),
        }),
      );

      // ---------------------------------------------------------- roles
      app.get('/v1/identity/roles', { config: { access: { kind: 'user' } } }, async (request) => ({
        data: await inScope(pool, systemScope, (client) => repo.listRoles(client)),
        meta: meta(request),
      }));

      app.post(
        '/v1/identity/roles',
        {
          schema: { body: createRoleBodySchema },
          config: { access: { kind: 'user', permission: 'platform.roles.manage' } },
        },
        async (request, reply) => {
          const body = request.body as z.infer<typeof createRoleBodySchema>;
          const invalid = body.permissions.filter((p) => !permissionAllowsScope(p, body.scope));
          if (invalid.length > 0) {
            throw new AtlasError('VALIDATION_FAILED', {
              detail: `Not permitted in a ${body.scope} role: ${invalid.join(', ')}`,
            });
          }
          const permissions = [...new Set(body.permissions)].sort();
          const role = await inScope(pool, systemScope, async (client) => {
            try {
              await repo.insertRole(client, { ...body, permissions });
            } catch (error) {
              if (isUniqueViolation(error))
                throw new AtlasError('CONFLICT', { detail: 'A role with this key exists' });
              throw error;
            }
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              action: 'role.created',
              resource: { type: 'role', id: body.key, name: body.name },
              outcome: 'success',
              changes: [
                { field: 'scope', before: null, after: body.scope },
                { field: 'permissions', before: null, after: permissions.join(' ') },
              ],
            });
            return repo.findRole(client, body.key);
          });
          reply.status(201);
          return { data: role, meta: meta(request) };
        },
      );

      app.put(
        '/v1/identity/roles/:roleKey',
        {
          schema: { params: roleParamsSchema, body: updateRoleBodySchema },
          config: { access: { kind: 'user', permission: 'platform.roles.manage' } },
        },
        async (request) => {
          const { roleKey } = request.params as z.infer<typeof roleParamsSchema>;
          const body = request.body as z.infer<typeof updateRoleBodySchema>;
          const role = await inScope(pool, systemScope, async (client) => {
            const existing = await repo.findRole(client, roleKey);
            if (!existing) throw new AtlasError('NOT_FOUND');
            if (existing.isSystem)
              throw new AtlasError('CONFLICT', { detail: 'System roles are read-only' });
            const invalid = body.permissions.filter(
              (p) => !permissionAllowsScope(p, existing.scope),
            );
            if (invalid.length > 0) {
              throw new AtlasError('VALIDATION_FAILED', {
                detail: `Not permitted in a ${existing.scope} role: ${invalid.join(', ')}`,
              });
            }
            const permissions = [...new Set(body.permissions)].sort();
            await repo.updateRole(client, roleKey, { ...body, permissions });
            const changes = diffFields(
              {
                name: existing.name,
                description: existing.description,
                permissions: existing.permissions.join(' '),
              },
              {
                name: body.name,
                description: body.description,
                permissions: permissions.join(' '),
              },
              ['name', 'description', 'permissions'],
            );
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              action: 'role.updated',
              resource: { type: 'role', id: roleKey, name: body.name },
              outcome: 'success',
              changes,
            });
            return repo.findRole(client, roleKey);
          });
          return { data: role, meta: meta(request) };
        },
      );

      // ---------------------------------------------------------- platform users
      app.get(
        '/v1/identity/platform-users',
        { config: { access: { kind: 'user', permission: 'platform.users.read' } } },
        async (request) => ({
          data: await inScope(pool, systemScope, (client) => repo.listPlatformUsers(client)),
          meta: meta(request),
        }),
      );

      app.post(
        '/v1/identity/platform-users',
        {
          schema: { body: inviteUserBodySchema },
          config: { access: { kind: 'user', permission: 'platform.users.manage' } },
        },
        async (request, reply) => {
          const body = request.body as z.infer<typeof inviteUserBodySchema>;
          const user = await inScope(pool, systemScope, async (client) => {
            await assertRolesHaveScope(client, body.roles, 'platform');
            const { row, invited } = await ensureLocalUser(client, body, true);
            const before = await repo.platformRolesOf(client, row.id);
            const roles = [...new Set([...before, ...body.roles])].sort();
            await repo.replacePlatformRoles(client, row.id, roles, actorId(request));
            const actor = {
              type: 'user' as const,
              id: actorId(request),
              displayName: request.principal!.displayName,
            };
            if (invited) {
              await audit.record(client, request.correlationId, {
                actor,
                action: 'user.invited',
                resource: { type: 'user', id: row.id, name: row.email },
                outcome: 'success',
                changes: [{ field: 'email', before: null, after: row.email }],
                metadata: { userType: 'platform' },
              });
            }
            await audit.record(client, request.correlationId, {
              actor,
              action: 'user.platform-roles.changed',
              resource: { type: 'user', id: row.id, name: row.email },
              outcome: 'success',
              changes: [
                {
                  field: 'platformRoles',
                  before: before.join(' ') || null,
                  after: roles.join(' '),
                },
              ],
            });
            return { ...repo.toUserSummary(row), roles };
          });
          reply.status(201);
          return { data: user, meta: meta(request) };
        },
      );

      app.put(
        '/v1/identity/platform-users/:userId/roles',
        {
          schema: { params: userParamsSchema, body: setRolesBodySchema },
          config: { access: { kind: 'user', permission: 'platform.users.manage' } },
        },
        async (request) => {
          const { userId } = request.params as z.infer<typeof userParamsSchema>;
          const { roles } = request.body as z.infer<typeof setRolesBodySchema>;
          if (userId === actorId(request)) {
            throw new AtlasError('CONFLICT', { detail: 'You cannot change your own roles' });
          }
          const result = await inScope(pool, systemScope, async (client) => {
            const user = await repo.findUser(client, userId);
            if (!user) throw new AtlasError('NOT_FOUND');
            await assertRolesHaveScope(client, roles, 'platform');
            const before = await repo.platformRolesOf(client, userId);
            const after = [...new Set(roles)].sort();
            if (
              before.includes('platform-super-admin') &&
              !after.includes('platform-super-admin')
            ) {
              if ((await repo.countActiveSuperAdmins(client, userId)) === 0) {
                throw new AtlasError('CONFLICT', {
                  detail: 'At least one active Platform Super Admin must remain',
                });
              }
            }
            await repo.replacePlatformRoles(client, userId, after, actorId(request));
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              action: 'user.platform-roles.changed',
              resource: { type: 'user', id: userId, name: user.email },
              outcome: 'success',
              changes: [
                {
                  field: 'platformRoles',
                  before: before.join(' ') || null,
                  after: after.join(' ') || null,
                },
              ],
            });
            return { ...repo.toUserSummary(user), roles: after };
          });
          return { data: result, meta: meta(request) };
        },
      );

      app.post(
        '/v1/identity/users/:userId/status',
        {
          schema: { params: userParamsSchema, body: setUserStatusBodySchema },
          config: { access: { kind: 'user' } },
        },
        async (request) => {
          const { userId } = request.params as z.infer<typeof userParamsSchema>;
          const body = request.body as z.infer<typeof setUserStatusBodySchema>;
          if (userId === actorId(request)) {
            throw new AtlasError('CONFLICT', {
              detail: 'You cannot change your own account status',
            });
          }
          const user = await inScope(pool, systemScope, async (client) => {
            const user = await repo.findUser(client, userId);
            if (!user) throw new AtlasError('NOT_FOUND');
            // Platform users are managed by platform user administrators; issuer users by those
            // who manage users in *every* issuer the user belongs to.
            const platformRoles = await repo.platformRolesOf(client, userId);
            const tenants = await repo.tenantsOf(client, userId);
            if (platformRoles.length > 0 || tenants.length === 0) {
              await request.authorize('platform.users.manage');
              if (body.status === 'disabled' && platformRoles.includes('platform-super-admin')) {
                if ((await repo.countActiveSuperAdmins(client, userId)) === 0) {
                  throw new AtlasError('CONFLICT', {
                    detail: 'At least one active Platform Super Admin must remain',
                  });
                }
              }
            } else {
              for (const tenantId of tenants)
                await request.authorize('issuer.users.manage', tenantId);
            }
            await repo.setUserStatus(client, userId, body.status);
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              action: body.status === 'disabled' ? 'user.disabled' : 'user.enabled',
              resource: { type: 'user', id: userId, name: user.email },
              outcome: 'success',
              changes: [{ field: 'status', before: user.status, after: body.status }],
              reason: body.reason,
            });
            return user;
          });
          // The identity provider is updated after commit: a disabled ATLAS account already has no
          // permissions, so a provider failure cannot leave access open.
          if (idp && user.idp_subject) {
            await idp.setEnabled(user.idp_subject, body.status === 'active');
            if (body.status === 'disabled')
              await idp.endSessions(user.idp_subject).catch(() => undefined);
          }
          return {
            data: { ...repo.toUserSummary(user), status: body.status },
            meta: meta(request),
          };
        },
      );

      // ---------------------------------------------------------- issuer users
      app.get(
        '/v1/tenants/:tenantId/users',
        {
          schema: { params: tenantParamsSchema },
          config: {
            access: { kind: 'user', permission: 'issuer.users.read', tenantParam: 'tenantId' },
          },
        },
        async (request) => {
          const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
          return {
            data: await inScope(pool, tenantScope(tenantId), (client) =>
              repo.listTenantUsers(client, tenantId),
            ),
            meta: meta(request),
          };
        },
      );

      app.post(
        '/v1/tenants/:tenantId/users',
        {
          schema: { params: tenantParamsSchema, body: inviteUserBodySchema },
          config: {
            access: { kind: 'user', permission: 'issuer.users.manage', tenantParam: 'tenantId' },
          },
        },
        async (request, reply) => {
          const { tenantId } = request.params as z.infer<typeof tenantParamsSchema>;
          const body = request.body as z.infer<typeof inviteUserBodySchema>;
          await assertTenantAcceptsUsers(tenantId, request.correlationId);
          const user = await inScope(pool, tenantScope(tenantId), async (client) => {
            await assertRolesHaveScope(client, body.roles, 'tenant');
            const { row, invited } = await ensureLocalUser(client, body, false);
            const before = await repo.tenantRolesOf(client, row.id, tenantId);
            const roles = [...new Set([...before, ...body.roles])].sort();
            await repo.replaceTenantRoles(client, row.id, tenantId, roles, actorId(request));
            const actor = {
              type: 'user' as const,
              id: actorId(request),
              displayName: request.principal!.displayName,
            };
            if (invited) {
              await audit.record(client, request.correlationId, {
                actor,
                tenantId,
                action: 'user.invited',
                resource: { type: 'user', id: row.id, name: row.email },
                outcome: 'success',
                changes: [{ field: 'email', before: null, after: row.email }],
                metadata: { userType: 'issuer' },
              });
            }
            await audit.record(client, request.correlationId, {
              actor,
              tenantId,
              action: 'user.tenant-roles.changed',
              resource: { type: 'user', id: row.id, name: row.email },
              outcome: 'success',
              changes: [
                { field: 'roles', before: before.join(' ') || null, after: roles.join(' ') },
              ],
            });
            return { ...repo.toUserSummary(row), tenantId, roles };
          });
          reply.status(201);
          return { data: user, meta: meta(request) };
        },
      );

      app.put(
        '/v1/tenants/:tenantId/users/:userId/roles',
        {
          schema: { params: tenantUserParamsSchema, body: setRolesBodySchema },
          config: {
            access: { kind: 'user', permission: 'issuer.users.manage', tenantParam: 'tenantId' },
          },
        },
        async (request) => {
          const { tenantId, userId } = request.params as z.infer<typeof tenantUserParamsSchema>;
          const { roles } = request.body as z.infer<typeof setRolesBodySchema>;
          if (roles.length === 0) {
            throw new AtlasError('VALIDATION_FAILED', {
              detail: 'Remove the user from the issuer instead',
            });
          }
          if (userId === actorId(request)) {
            throw new AtlasError('CONFLICT', { detail: 'You cannot change your own roles' });
          }
          const result = await inScope(pool, tenantScope(tenantId), async (client) => {
            const user = await repo.findUser(client, userId);
            const before = user ? await repo.tenantRolesOf(client, userId, tenantId) : [];
            if (!user || before.length === 0) throw new AtlasError('NOT_FOUND');
            await assertRolesHaveScope(client, roles, 'tenant');
            const after = [...new Set(roles)].sort();
            await repo.replaceTenantRoles(client, userId, tenantId, after, actorId(request));
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              tenantId,
              action: 'user.tenant-roles.changed',
              resource: { type: 'user', id: userId, name: user.email },
              outcome: 'success',
              changes: [{ field: 'roles', before: before.join(' '), after: after.join(' ') }],
            });
            return { ...repo.toUserSummary(user), tenantId, roles: after };
          });
          return { data: result, meta: meta(request) };
        },
      );

      app.delete(
        '/v1/tenants/:tenantId/users/:userId',
        {
          schema: { params: tenantUserParamsSchema },
          config: {
            access: { kind: 'user', permission: 'issuer.users.manage', tenantParam: 'tenantId' },
          },
        },
        async (request, reply) => {
          const { tenantId, userId } = request.params as z.infer<typeof tenantUserParamsSchema>;
          if (userId === actorId(request)) {
            throw new AtlasError('CONFLICT', {
              detail: 'You cannot remove yourself from an issuer',
            });
          }
          await inScope(pool, tenantScope(tenantId), async (client) => {
            const user = await repo.findUser(client, userId);
            const before = user ? await repo.tenantRolesOf(client, userId, tenantId) : [];
            if (!user || before.length === 0) throw new AtlasError('NOT_FOUND');
            await repo.replaceTenantRoles(client, userId, tenantId, [], actorId(request));
            await audit.record(client, request.correlationId, {
              actor: {
                type: 'user',
                id: actorId(request),
                displayName: request.principal!.displayName,
              },
              tenantId,
              action: 'user.tenant-membership.removed',
              resource: { type: 'user', id: userId, name: user.email },
              outcome: 'success',
              changes: [{ field: 'roles', before: before.join(' '), after: null }],
            });
          });
          reply.status(204);
        },
      );

      // ---------------------------------------------------------- helpers
      async function assertRolesHaveScope(
        client: import('pg').PoolClient,
        roles: readonly string[],
        scope: 'platform' | 'tenant',
      ) {
        for (const key of roles) {
          const role = await repo.findRole(client, key);
          if (!role || role.scope !== scope) {
            throw new AtlasError('VALIDATION_FAILED', {
              detail: `Role ${key} cannot be assigned here`,
            });
          }
        }
      }

      async function ensureLocalUser(
        client: import('pg').PoolClient,
        body: z.infer<typeof inviteUserBodySchema>,
        platform: boolean,
      ) {
        const existing = await repo.findUserByEmail(client, body.email);
        if (existing) {
          if (existing.status === 'disabled') {
            throw new AtlasError('CONFLICT', {
              detail: 'This account is disabled; enable it first',
            });
          }
          return { row: existing, invited: false };
        }
        let subject: string | null = null;
        if (idp) {
          subject = await idp.ensureUser({
            email: body.email,
            ...splitName(body.displayName),
            requireMfa: platform,
          });
        }
        const row = await repo.insertUser(client, {
          email: body.email,
          displayName: body.displayName,
          subject,
          isSynthetic: config.ATLAS_ENV !== 'production' && config.ATLAS_ENV !== 'staging',
        });
        if (idp && subject) {
          const sent = await idp.sendInvitation(subject, platform);
          if (!sent) logger.warn({ userId: row.id }, 'invitation email could not be sent');
        }
        return { row, invited: true };
      }

      /** The issuer must exist and not be offboarded (asked of its owner, issuer-service). */
      async function assertTenantAcceptsUsers(tenantId: string, correlationId: string) {
        const response = await issuer.get(`/v1/internal/tenants/${tenantId}`, {
          correlationId,
          schema: successEnvelope(tenantSummarySchema),
        });
        if (response.body.data.status === 'offboarded') {
          throw new AtlasError('CONFLICT', {
            detail: 'Users cannot be added to an offboarded issuer',
          });
        }
      }
    },
  });
}

export const definition = createIdentityService();
