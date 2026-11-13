import {
  activityRecordedV1,
  authorizer,
  csrfHeader,
  headers,
  type ActivityRecorded,
  type PlatformServices,
  type Principal,
  type ServiceName,
  type Session,
  type SuccessEnvelope,
} from '@atlas/contracts';
import { booleanStringSchema, commaListSchema, positiveIntSchema, z } from '@atlas/schemas';
import { rateLimitDefaults } from '@atlas/security';
import {
  applyMfaPolicy,
  buildEnvelope,
  createRemotePrincipalResolver,
  defineService,
  EventPublisher,
  readPackageVersion,
} from '@atlas/service-kit';
import { AtlasError } from '@atlas/shared';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createOidcClient } from './oidc.js';
import { collectPlatformHealth } from './platform-health.js';
import { createResilientRateLimitStore } from './rate-limit-store.js';
import {
  cookieNames,
  parseCookies,
  serialiseCookie,
  SessionStore,
  tokensMatch,
  type SessionRecord,
} from './sessions.js';
import { ValkeyOutbox } from './valkey-outbox.js';

/**
 * API Gateway — Stage 1A: the portal's backend-for-frontend and the only public entry point.
 *
 *  - Signs portal users in with OpenID Connect (authorisation code + PKCE) and keeps their tokens
 *    server-side; the browser holds one HttpOnly session cookie.
 *  - Enforces session idle/absolute expiry, refreshes access tokens, checks CSRF on writes.
 *  - Forwards portal API calls to the owning service with a service token for that service and
 *    the user's access token. Authorisation is decided by the services, not here.
 *  - Rate-limits per client with shared counters in Valkey.
 *  - Records sign-in, sign-out, session expiry and denied requests in the audit trail.
 */
const SESSION_PATHS = /^\/v1\/(tenants|identity|audit)(\/|$)/;

const policies = {
  session: { max: 120, timeWindow: 60_000 },
  read: { max: rateLimitDefaults.portal.max, timeWindow: rateLimitDefaults.portal.timeWindowMs },
  /** Administrative writes: per session. */
  write: { max: 60, timeWindow: 60_000 },
  /** Sensitive configuration and access changes: per session. */
  sensitive: { max: 20, timeWindow: 60_000 },
} as const;

/** Proxied API surface → owning service. Order matters: more specific prefixes first. */
const routeTable: { pattern: RegExp; service: ServiceName }[] = [
  { pattern: /^\/v1\/tenants\/[^/]+\/users(\/|$|\?)/, service: 'identity-service' },
  { pattern: /^\/v1\/tenants\/[^/]+\/audit(\/|$|\?)/, service: 'audit-service' },
  { pattern: /^\/v1\/tenants(\/|$|\?)/, service: 'issuer-service' },
  { pattern: /^\/v1\/identity\//, service: 'identity-service' },
  { pattern: /^\/v1\/audit\//, service: 'audit-service' },
];

const sensitiveRoutes: { method: 'POST' | 'PUT'; url: string }[] = [
  { method: 'PUT', url: '/v1/tenants/:tenantId/configuration' },
  { method: 'POST', url: '/v1/tenants/:tenantId/status' },
  { method: 'PUT', url: '/v1/tenants/:tenantId/users/:userId/roles' },
  { method: 'POST', url: '/v1/identity/users/:userId/status' },
  { method: 'PUT', url: '/v1/identity/platform-users/:userId/roles' },
  { method: 'POST', url: '/v1/identity/roles' },
  { method: 'PUT', url: '/v1/identity/roles/:roleKey' },
];

declare module 'fastify' {
  interface FastifyRequest {
    session: { id: string; record: SessionRecord } | null;
  }
}

export const definition = defineService({
  name: 'api-gateway',
  version: readPackageVersion(import.meta.url),
  dependencies: ['valkey', 'rabbitmq'],
  security: { calls: ['identity-service', 'issuer-service', 'audit-service'] },
  configShape: {
    /** Browser origins permitted to call the gateway. Never "*". */
    CORS_ALLOWED_ORIGINS: commaListSchema
      .pipe(z.array(z.url()))
      .default(['http://localhost:5173', 'http://127.0.0.1:5173']),
    HEALTH_PROBE_TIMEOUT_MS: positiveIntSchema.default(1_500),
    RATE_LIMIT_MAX: positiveIntSchema.default(rateLimitDefaults.portal.max),
    /** Public base URL of the portal (redirect target after sign-in and sign-out). */
    PORTAL_PUBLIC_URL: z.url().default('http://localhost:8080'),
    OIDC_CLIENT_ID: z.string().min(1).default('atlas-gateway'),
    OIDC_CLIENT_SECRET: z.string().min(16),
    /** 32-byte key (64 hex characters) encrypting server-side session data. */
    SESSION_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
    SESSION_IDLE_TIMEOUT_MS: positiveIntSchema.default(30 * 60_000),
    SESSION_ABSOLUTE_TIMEOUT_MS: positiveIntSchema.default(8 * 3600_000),
    /** Secure cookies (HTTPS, or http://localhost which browsers treat as secure). */
    COOKIE_SECURE: booleanStringSchema.default(true),
    UPSTREAM_TIMEOUT_MS: positiveIntSchema.default(10_000),
    /** Sign-in starts and callbacks per client address per 5 minutes. */
    RATE_LIMIT_SIGN_IN_MAX: positiveIntSchema.default(20),
  },
  async register(app, context) {
    const { config, logger, metadata, metrics } = context;
    const redis = context.infrastructure.valkey!.client;
    const tokens = context.security!.tokens!;
    const verifier = context.security!.verifier;
    const portal = config.PORTAL_PUBLIC_URL.replace(/\/$/, '');
    const cookies = cookieNames(config.COOKIE_SECURE);
    const allowedOrigins = new Set([...config.CORS_ALLOWED_ORIGINS, new URL(portal).origin]);

    const authentication = { max: config.RATE_LIMIT_SIGN_IN_MAX, timeWindow: 5 * 60_000 };
    const sessions = new SessionStore(redis, config.SESSION_ENCRYPTION_KEY, {
      idleMs: config.SESSION_IDLE_TIMEOUT_MS,
      absoluteMs: config.SESSION_ABSOLUTE_TIMEOUT_MS,
    });
    const oidc = createOidcClient({
      publicIssuer: config.OIDC_ISSUER_URL!,
      internalIssuer: config.OIDC_INTERNAL_URL ?? config.OIDC_ISSUER_URL!,
      clientId: config.OIDC_CLIENT_ID,
      clientSecret: config.OIDC_CLIENT_SECRET,
      redirectUri: `${portal}/api/v1/auth/callback`,
      postLogoutRedirectUri: `${portal}/signed-out`,
      allowHttp: config.ATLAS_ENV !== 'production',
    });
    const principals = createRemotePrincipalResolver({
      identityService: context.clients['identity-service']!,
    });

    // ---- Audit events go through a durable Valkey outbox to RabbitMQ.
    const publisher = new EventPublisher(context.infrastructure.rabbitmq!, 'api-gateway', {
      logger,
    });
    const outbox = new ValkeyOutbox(redis, publisher, logger, metrics);
    outbox.start();
    context.onShutdown(() => outbox.stop());

    const recordAudit = async (
      request: FastifyRequest,
      entry: Omit<ActivityRecorded, 'occurredAt'>,
    ) => {
      try {
        await outbox.enqueue(
          buildEnvelope(
            activityRecordedV1,
            { ...entry, occurredAt: new Date().toISOString() },
            { service: 'api-gateway', correlationId: request.correlationId },
          ),
        );
      } catch (error) {
        // Valkey is down: the session store is down too, so the request itself fails. Log loudly.
        request.log.error({ error, action: entry.action }, 'could not queue audit event');
      }
    };

    // ---- Edge protections
    await app.register(cors, {
      origin: config.CORS_ALLOWED_ORIGINS,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['content-type', 'accept', headers.correlationId, csrfHeader],
      exposedHeaders: ['x-correlation-id', 'x-request-id'],
      maxAge: 600,
    });

    const sessionKey = (request: FastifyRequest) => {
      const id = parseCookies(request.headers.cookie)[cookies.session];
      return id ? `s:${id.slice(0, 16)}` : `ip:${request.ip}`;
    };
    // Registered after the infrastructure endpoints, so orchestrator probes are never limited.
    await app.register(rateLimit, {
      max: config.RATE_LIMIT_MAX,
      timeWindow: rateLimitDefaults.portal.timeWindowMs,
      store: createResilientRateLimitStore(redis, logger),
      keyGenerator: sessionKey,
      errorResponseBuilder: (_request, limit) =>
        new AtlasError('RATE_LIMITED', { detail: `Retry after ${Math.ceil(limit.ttl / 1000)}s` }),
    });
    // The plugin only covers registered routes; limit unmatched paths too, so path scanning
    // against the edge is throttled like any other traffic.
    const limitUnmatched = app.rateLimit();
    app.addHook('onRequest', async function (request, reply) {
      if (request.is404) await limitUnmatched.call(this, request, reply);
    });

    // ---- Sessions
    app.decorateRequest('session', null);
    const clearSessionCookie = (reply: FastifyReply) =>
      reply.header(
        'set-cookie',
        serialiseCookie(cookies.session, '', { secure: config.COOKIE_SECURE, maxAgeSeconds: 0 }),
      );

    const refreshing = new Map<string, Promise<SessionRecord | null>>();
    const refreshIfNeeded = async (
      id: string,
      record: SessionRecord,
    ): Promise<SessionRecord | null> => {
      if (record.accessExpiresAt - Date.now() > 60_000) return record;
      if (!record.refreshToken) return null;
      let pending = refreshing.get(id);
      if (!pending) {
        pending = (async () => {
          try {
            const next = await oidc.refresh(record.refreshToken!);
            return {
              ...record,
              accessToken: next.accessToken,
              accessExpiresAt: next.expiresAt,
              refreshToken: next.refreshToken,
              idToken: next.idToken ?? record.idToken,
            };
          } catch {
            // Another gateway instance may have rotated the refresh token first.
            const latest = await sessions.load(id);
            if (
              latest &&
              'session' in latest &&
              latest.session.accessExpiresAt - Date.now() > 60_000
            ) {
              return latest.session;
            }
            return null; // the provider ended the session (expired, signed out or disabled)
          }
        })().finally(() => refreshing.delete(id));
        refreshing.set(id, pending);
      }
      return pending;
    };

    /** Loads, validates, refreshes and slides the caller's session; null when there is none. */
    const loadSession = async (request: FastifyRequest, reply: FastifyReply) => {
      const id = parseCookies(request.headers.cookie)[cookies.session];
      if (!id) return null;
      const loaded = await sessions.load(id);
      if (!loaded) {
        clearSessionCookie(reply);
        return null;
      }
      if ('expired' in loaded) {
        clearSessionCookie(reply);
        await recordAudit(request, {
          actor: {
            type: 'user',
            id: loaded.previous.userId,
            displayName: loaded.previous.displayName,
          },
          action: 'auth.session.expired',
          resource: { type: 'session', id: 'portal' },
          outcome: 'failure',
          metadata: { reason: 'idle-or-absolute-timeout' },
        });
        throw new AtlasError('UNAUTHENTICATED', {
          detail: 'Your session has expired. Please sign in again.',
        });
      }
      const refreshed = await refreshIfNeeded(id, loaded.session);
      if (!refreshed) {
        await sessions.destroy(id);
        clearSessionCookie(reply);
        await recordAudit(request, {
          actor: {
            type: 'user',
            id: loaded.session.userId,
            displayName: loaded.session.displayName,
          },
          action: 'auth.session.expired',
          resource: { type: 'session', id: 'portal' },
          outcome: 'failure',
          metadata: { reason: 'refresh-refused' },
        });
        throw new AtlasError('UNAUTHENTICATED', {
          detail: 'Your session has expired. Please sign in again.',
        });
      }
      const touched = sessions.touch(refreshed);
      // Persist when tokens changed or the idle window moved meaningfully (limits writes).
      if (
        refreshed !== loaded.session ||
        touched.idleExpiresAt - loaded.session.idleExpiresAt > 30_000
      ) {
        await sessions.save(id, touched);
      }
      request.session = { id, record: touched };
      return request.session;
    };

    const requireSession = async (request: FastifyRequest, reply: FastifyReply) => {
      const session = await loadSession(request, reply);
      if (!session) throw new AtlasError('UNAUTHENTICATED', { detail: 'Sign in to continue' });
      return session;
    };

    const principalOf = async (
      request: FastifyRequest,
      record: SessionRecord,
    ): Promise<Principal> => {
      const principal = await principals.resolve(record.subject, {
        correlationId: request.correlationId,
      });
      if (!principal || principal.status !== 'active') {
        await sessions.destroy(request.session!.id);
        throw new AtlasError('UNAUTHENTICATED', { detail: 'Your ATLAS account is not active' });
      }
      return applyMfaPolicy(principal, record.amr, config.PLATFORM_MFA_REQUIRED);
    };

    /** CSRF: state-changing requests must carry the session's token and a permitted Origin. */
    const checkCsrf = async (request: FastifyRequest, record: SessionRecord) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      const origin = request.headers.origin;
      const supplied = request.headers[csrfHeader];
      if (
        (origin && !allowedOrigins.has(origin)) ||
        !tokensMatch(typeof supplied === 'string' ? supplied : undefined, record.csrfToken)
      ) {
        metrics.accessDenied.inc({ reason: 'csrf' });
        await recordAudit(request, {
          actor: { type: 'user', id: record.userId, displayName: record.displayName },
          action: 'access.denied',
          resource: {
            type: 'api-route',
            id: `${request.method} ${request.routeOptions.url ?? 'unmatched'}`.slice(0, 128),
          },
          outcome: 'denied',
          metadata: { reason: 'csrf', method: request.method },
        });
        throw new AtlasError('FORBIDDEN', {
          detail: 'Request could not be verified. Reload the page and try again.',
        });
      }
    };

    const safeReturnTo = (value: unknown) =>
      typeof value === 'string' && /^\/(?![/\\])[\w\-./?=&%#]*$/.test(value) && value.length <= 512
        ? value
        : '/';

    // ---------------------------------------------------------------- authentication
    app.get(
      '/v1/auth/login',
      {
        config: {
          rateLimit: {
            ...authentication,
            keyGenerator: (r: FastifyRequest) => `ip:${r.ip}`,
          },
        },
      },
      async (request, reply) => {
        const returnTo = safeReturnTo((request.query as Record<string, unknown>).returnTo);
        const start = await oidc.startSignIn();
        await sessions.saveLoginState(start.state, {
          codeVerifier: start.codeVerifier,
          nonce: start.nonce,
          returnTo,
          createdAt: Date.now(),
        });
        // Binds the sign-in to this browser: the callback must present the same state.
        reply.header(
          'set-cookie',
          serialiseCookie(cookies.login, start.state, {
            secure: config.COOKIE_SECURE,
            maxAgeSeconds: 600,
          }),
        );
        return reply.redirect(start.url, 302);
      },
    );

    app.get(
      '/v1/auth/callback',
      {
        config: {
          rateLimit: {
            ...authentication,
            keyGenerator: (r: FastifyRequest) => `ip:${r.ip}`,
          },
        },
      },
      async (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const browserState = parseCookies(request.headers.cookie)[cookies.login];
        reply.header(
          'set-cookie',
          serialiseCookie(cookies.login, '', { secure: config.COOKIE_SECURE, maxAgeSeconds: 0 }),
        );
        const fail = async (reason: string) => {
          await recordAudit(request, {
            actor: { type: 'anonymous', id: 'anonymous' },
            action: 'auth.sign-in.failed',
            resource: { type: 'session', id: 'portal' },
            outcome: 'failure',
            metadata: { reason },
          });
          return reply.redirect(`${portal}/signed-out?reason=${encodeURIComponent(reason)}`, 302);
        };
        if (query.error)
          return fail(/^[a-z_]{1,40}$/.test(query.error) ? query.error : 'provider-error');
        if (!query.state || !browserState || query.state !== browserState)
          return fail('state-mismatch');
        const login = await sessions.takeLoginState(query.state);
        if (!login) return fail('sign-in-expired');

        let signedIn;
        try {
          const raw = request.url.slice(request.url.indexOf('?'));
          signedIn = await oidc.completeSignIn(raw, {
            state: query.state,
            nonce: login.nonce,
            codeVerifier: login.codeVerifier,
          });
          // The access token must be one the services will accept.
          await verifier.verifyUserToken(signedIn.accessToken);
        } catch (error) {
          request.log.warn(
            { error: { name: (error as Error).name } },
            'sign-in code exchange failed',
          );
          return fail('token-exchange-failed');
        }

        const response = await context.clients['identity-service']!.post<{ data: Principal }>(
          `/v1/internal/principals/${encodeURIComponent(signedIn.subject)}/sign-ins`,
          { correlationId: request.correlationId, acceptStatus: (s) => s === 200 || s === 404 },
        );
        if (response.status === 404) return fail('no-account');
        if (response.body.data.status !== 'active') return fail('account-disabled');
        principals.invalidate(signedIn.subject);

        const principal = response.body.data;
        const id = SessionStore.newId();
        const record = sessions.create({
          subject: signedIn.subject,
          userId: principal.userId,
          displayName: principal.displayName,
          idpSessionId: signedIn.idpSessionId,
          accessToken: signedIn.accessToken,
          accessExpiresAt: signedIn.expiresAt,
          refreshToken: signedIn.refreshToken,
          idToken: signedIn.idToken,
          amr: signedIn.amr,
        });
        await sessions.save(id, record);
        reply.header('set-cookie', [
          serialiseCookie(cookies.login, '', { secure: config.COOKIE_SECURE, maxAgeSeconds: 0 }),
          serialiseCookie(cookies.session, id, { secure: config.COOKIE_SECURE }),
        ]);
        const mfa = signedIn.amr.includes('otp');
        await recordAudit(request, {
          actor: { type: 'user', id: principal.userId, displayName: principal.displayName },
          action: 'auth.signed-in',
          resource: { type: 'session', id: 'portal' },
          outcome: 'success',
          metadata: {
            mfa,
            platformAccess:
              principal.platformPermissions.length > 0 && (mfa || !config.PLATFORM_MFA_REQUIRED),
          },
        });
        return reply.redirect(`${portal}${login.returnTo}`, 302);
      },
    );

    app.post(
      '/v1/auth/logout',
      { config: { rateLimit: policies.session } },
      async (request, reply) => {
        const session = await loadSession(request, reply).catch(() => null);
        if (!session) {
          clearSessionCookie(reply);
          return { data: { endSessionUrl: null }, meta: meta(request) };
        }
        // A forged cross-site request must not be able to sign the user out either.
        await checkCsrf(request, session.record);
        await sessions.destroy(session.id);
        clearSessionCookie(reply);
        await recordAudit(request, {
          actor: {
            type: 'user',
            id: session.record.userId,
            displayName: session.record.displayName,
          },
          action: 'auth.signed-out',
          resource: { type: 'session', id: 'portal' },
          outcome: 'success',
        });
        return {
          data: { endSessionUrl: oidc.endSessionUrl(session.record.idToken) },
          meta: meta(request),
        };
      },
    );

    app.get(
      '/v1/session',
      { config: { rateLimit: policies.session } },
      async (request, reply): Promise<SuccessEnvelope<Session>> => {
        reply.header('cache-control', 'no-store');
        const session = await requireSession(request, reply);
        const principal = await principalOf(request, session.record);
        return {
          data: {
            principal,
            csrfToken: session.record.csrfToken,
            authenticatedAt: new Date(session.record.authenticatedAt).toISOString(),
            expiresAt: new Date(session.record.absoluteExpiresAt).toISOString(),
            idleExpiresAt: new Date(session.record.idleExpiresAt).toISOString(),
            mfa: session.record.amr.includes('otp'),
            accountUrl: oidc.accountUrl,
          },
          meta: meta(request),
        };
      },
    );

    // ---------------------------------------------------------------- platform health
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
      async (request, reply): Promise<SuccessEnvelope<PlatformServices>> => {
        const session = await requireSession(request, reply);
        const principal = await principalOf(request, session.record);
        if (!authorizer(principal).can('platform.health.read')) {
          throw new AtlasError('FORBIDDEN', { detail: 'Requires platform.health.read' });
        }
        const data = await collectPlatformHealth({
          urls: config.ATLAS_SERVICE_URLS,
          self: metadata.name,
          timeoutMs: config.HEALTH_PROBE_TIMEOUT_MS,
          correlationId: request.correlationId,
        });
        return { data, meta: meta(request) };
      },
    );

    // ---------------------------------------------------------------- API forwarding
    const forward = async (request: FastifyRequest, reply: FastifyReply) => {
      const path = request.url;
      const pathname = path.split('?')[0]!;
      const target = routeTable.find((entry) => entry.pattern.test(pathname))?.service;
      if (!target || !SESSION_PATHS.test(pathname)) throw new AtlasError('NOT_FOUND');
      const session = await requireSession(request, reply);
      await checkCsrf(request, session.record);

      const outbound: Record<string, string> = {
        accept: 'application/json',
        [headers.correlationId]: request.correlationId,
        [headers.caller]: 'api-gateway',
        [headers.authorization]: `Bearer ${await tokens.token(target)}`,
        [headers.userToken]: session.record.accessToken,
      };
      const hasBody =
        request.body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(request.method);
      if (hasBody) outbound['content-type'] = 'application/json';

      const send = async (): Promise<Response> => {
        try {
          return await fetch(`${config.ATLAS_SERVICE_URLS[target]}${path}`, {
            method: request.method,
            headers: outbound,
            ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
            signal: AbortSignal.timeout(config.UPSTREAM_TIMEOUT_MS),
          });
        } catch (error) {
          throw new AtlasError(
            (error as Error).name === 'TimeoutError'
              ? 'UPSTREAM_TIMEOUT'
              : 'DEPENDENCY_UNAVAILABLE',
            { cause: error },
          );
        }
      };
      let upstream = await send();
      // A cached service token can outlive a provider signing-key change: renew it once.
      if (upstream.status === 401 && tokens.invalidate) {
        tokens.invalidate(target);
        outbound[headers.authorization] = `Bearer ${await tokens.token(target)}`;
        upstream = await send();
      }
      reply.status(upstream.status);
      reply.header('cache-control', 'no-store');
      const type = upstream.headers.get('content-type');
      if (type) reply.type(type);
      if (upstream.status === 204) return reply.send();
      return reply.send(await upstream.text());
    };

    const proxied = ['/v1/tenants', '/v1/tenants/*', '/v1/identity/*', '/v1/audit/*'];
    for (const url of proxied) {
      app.route({ method: ['GET'], url, config: { rateLimit: policies.read }, handler: forward });
      app.route({
        method: ['POST', 'PUT', 'PATCH', 'DELETE'],
        url,
        config: { rateLimit: { ...policies.write, keyGenerator: sessionKey } },
        handler: forward,
      });
    }
    for (const route of sensitiveRoutes) {
      app.route({
        method: route.method,
        url: route.url,
        config: { rateLimit: { ...policies.sensitive, keyGenerator: sessionKey } },
        handler: forward,
      });
    }
  },
});

function meta(request: FastifyRequest) {
  return { correlationId: request.correlationId, apiVersion: 'v1' };
}
