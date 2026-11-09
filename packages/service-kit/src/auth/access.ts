import {
  authorizer,
  headers,
  type Authorizer,
  type Permission,
  type Principal,
  type ServiceName,
} from '@atlas/contracts';
import { tenantIdSchema } from '@atlas/schemas';
import { AtlasError } from '@atlas/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bearerToken, type TokenVerifier, type VerifiedUserToken } from './tokens.js';

/**
 * Route access control — deny by default (Stage 1A).
 *
 * Every route outside the infrastructure endpoints (/health, /info, /metrics) must declare an
 * access policy in its route config, or the service refuses to start:
 *
 *   { access: { kind: 'service', callers: ['api-gateway'] } }
 *       service-to-service only: a valid service token from one of the listed callers.
 *
 *   { access: { kind: 'user', permission: 'issuer.read', tenantParam: 'tenantId' } }
 *       a signed-in user, via an allowed calling service (default: api-gateway). The user's
 *       principal is resolved from identity-service and the permission is checked:
 *         - with tenantParam: within that tenant (platform-wide grants also apply). A user with no
 *           access to the tenant at all receives 404, so another issuer's existence is not disclosed;
 *           a user of that tenant lacking the permission receives 403.
 *         - without tenantParam: platform-wide.
 *         - with no permission: any active user (the handler filters what they may see).
 *
 * Tenant context therefore always comes from the verified principal; a tenant id in the path is
 * only ever *checked against* it. Client-supplied tenant ids in bodies or queries must be checked
 * the same way by handlers (request.authorize).
 */
export type AccessPolicy =
  | { kind: 'service'; callers: readonly ServiceName[] }
  | {
      kind: 'user';
      callers?: readonly ServiceName[];
      permission?: Permission;
      tenantParam?: string;
    };

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: AccessPolicy;
  }
  interface FastifyRequest {
    /** Authenticated calling service (from its service token). */
    caller: ServiceName | null;
    /** Verified end-user token, when the route serves a user. */
    user: VerifiedUserToken | null;
    /** The user's resolved principal (MFA rules applied). */
    principal: Principal | null;
    authz: Authorizer | null;
    /**
     * Checks a permission for the current user, optionally within a tenant, throwing the
     * appropriate 403/404 (and recording the denial) when it does not hold.
     */
    authorize(permission: Permission, tenantId?: string): Promise<void>;
  }
}

export interface PrincipalResolver {
  /** Resolves an IdP subject to its principal; null when there is no ATLAS account. */
  resolve(subject: string, context: { correlationId: string }): Promise<Principal | null>;
}

export interface AccessDeniedEvent {
  request: FastifyRequest;
  reason: 'forbidden' | 'tenant-not-accessible' | 'no-account' | 'caller-not-allowed';
  permission?: Permission;
  tenantId?: string;
}

export interface AccessControlOptions {
  service: ServiceName;
  verifier: TokenVerifier;
  principals: PrincipalResolver;
  /** Platform permissions require a second factor at sign-in (amr contains "otp"). Default true. */
  platformMfaRequired: boolean;
  /** Called (awaited, errors swallowed) whenever access is denied after authentication. */
  onDenied?: (event: AccessDeniedEvent) => Promise<void>;
}

const infrastructureRoute = /^\/(health|metrics|info)(\/|$)/;
const MFA_METHODS = new Set(['otp', 'mfa', 'hwk', 'swk']);

/** Removes platform-wide permissions when the sign-in did not use a second factor. */
export function applyMfaPolicy(
  principal: Principal,
  amr: readonly string[],
  required: boolean,
): Principal {
  if (!required || amr.some((method) => MFA_METHODS.has(method))) return principal;
  return { ...principal, platformPermissions: [], platformRoles: [] };
}

export function installAccessControl(app: FastifyInstance, options: AccessControlOptions): void {
  app.decorateRequest('caller', null);
  app.decorateRequest('user', null);
  app.decorateRequest('principal', null);
  app.decorateRequest('authz', null);
  app.decorateRequest('authorize', async function () {
    throw new AtlasError('INTERNAL_ERROR');
  });

  // Deny by default: refuse to start if any application route forgot to declare a policy.
  app.addHook('onRoute', (route) => {
    if (infrastructureRoute.test(route.url)) return;
    const access = (route.config as { access?: AccessPolicy } | undefined)?.access;
    if (!access) {
      throw new Error(`Route ${route.method} ${route.url} declares no access policy`);
    }
  });

  const deny = async (event: AccessDeniedEvent, error: AtlasError): Promise<never> => {
    event.request.log.info(
      { reason: event.reason, permission: event.permission, tenantId: event.tenantId },
      'access denied',
    );
    await options
      .onDenied?.(event)
      .catch((failure: unknown) =>
        event.request.log.error({ error: failure }, 'failed to record access-denied event'),
      );
    throw error;
  };

  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config.access;
    if (!access) return; // infrastructure endpoints and 404s

    // 1. Calling service: every application route requires a service token.
    const token = bearerToken(request.headers[headers.authorization]);
    if (!token) throw new AtlasError('UNAUTHENTICATED', { detail: 'Service token required' });
    const verified = await options.verifier.verifyServiceToken(token, options.service);
    request.caller = verified.caller;
    const callers = access.callers ?? ['api-gateway'];
    if (!callers.includes(verified.caller)) {
      await deny(
        { request, reason: 'caller-not-allowed' },
        new AtlasError('FORBIDDEN', { detail: 'Calling service is not permitted on this route' }),
      );
    }
    if (access.kind === 'service') return;

    // 2. End user: verified independently of the calling service.
    const userToken = request.headers[headers.userToken];
    if (typeof userToken !== 'string' || userToken.length === 0) {
      throw new AtlasError('UNAUTHENTICATED', { detail: 'User token required' });
    }
    const user = await options.verifier.verifyUserToken(userToken);
    request.user = user;

    // 3. Principal from server-side associations — never from the token's own role claims.
    const resolved = await options.principals.resolve(user.subject, {
      correlationId: request.correlationId,
    });
    if (!resolved || resolved.status !== 'active') {
      await deny(
        { request, reason: 'no-account' },
        new AtlasError('FORBIDDEN', { detail: 'No active ATLAS account for this user' }),
      );
      return;
    }
    const principal = applyMfaPolicy(resolved, user.amr, options.platformMfaRequired);
    request.principal = principal;
    const authz = authorizer(principal);
    request.authz = authz;

    request.authorize = async (permission, tenantId) => {
      if (tenantId === undefined) {
        if (!authz.can(permission)) {
          await deny(
            { request, reason: 'forbidden', permission },
            new AtlasError('FORBIDDEN', { detail: `Requires ${permission}` }),
          );
        }
        return;
      }
      if (authz.can(permission, tenantId)) return;
      const member = principal.tenants.some((t) => t.tenantId === tenantId);
      const platformReader = authz.can('issuer.read');
      if (!member && !platformReader) {
        await deny(
          { request, reason: 'tenant-not-accessible', permission, tenantId },
          new AtlasError('NOT_FOUND'),
        );
      }
      await deny(
        { request, reason: 'forbidden', permission, tenantId },
        new AtlasError('FORBIDDEN', { detail: `Requires ${permission}` }),
      );
    };

    // 4. Declarative route permission.
    if (access.permission) {
      if (access.tenantParam) {
        const raw = (request.params as Record<string, unknown> | undefined)?.[access.tenantParam];
        const parsed = tenantIdSchema.safeParse(raw);
        if (!parsed.success) throw new AtlasError('NOT_FOUND');
        await request.authorize(access.permission, parsed.data);
      } else {
        await request.authorize(access.permission);
      }
    }
  });
}

/** Database scope for a permission: every tenant, or the listed tenants only. */
export type TenantScope = { kind: 'all' } | { kind: 'tenant'; tenantIds: readonly string[] };

export function scopeFor(authz: Authorizer, permission: Permission): TenantScope {
  const ids = authz.tenantIds(permission);
  return ids === 'all' ? { kind: 'all' } : { kind: 'tenant', tenantIds: ids };
}

/** Tenant-scoped requests: the scope is exactly the (already authorised) tenant. */
export function tenantScope(tenantId: string): TenantScope {
  return { kind: 'tenant', tenantIds: [tenantId] };
}
