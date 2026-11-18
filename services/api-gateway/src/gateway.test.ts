import { problemDetailsSchema, serviceNames } from '@atlas/contracts';
import { createService, defineService, type RunningService } from '@atlas/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPlatformHealth } from './platform-health.js';
import { resolveServiceUrls } from './registry.js';
import { definition } from './service.js';
import { SessionStore } from './sessions.js';

const running: RunningService<never>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.stop()));
});

const gatewayEnv = {
  ATLAS_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '0',
  // Unreachable infrastructure: the gateway must still start, and fail closed.
  VALKEY_URL: 'redis://:x@127.0.0.1:1/0',
  RABBITMQ_URL: 'amqp://x:x@127.0.0.1:1',
  OIDC_ISSUER_URL: 'https://idp.test/realms/atlas',
  SERVICE_CLIENT_SECRET: 'test-client-secret-0123456789',
  OIDC_CLIENT_SECRET: 'test-gateway-secret-0123456789',
  SESSION_ENCRYPTION_KEY: '0'.repeat(64),
};

async function startGateway(env: Record<string, string> = {}) {
  const gateway = await createService(definition, { ...gatewayEnv, ...env });
  running.push(gateway as unknown as RunningService<never>);
  return gateway;
}

/** A real ATLAS service instance, built from the service kit, standing in for a peer. */
async function startPeer(name: 'protocol' | 'fraud-engine', env: Record<string, string> = {}) {
  const peer = await createService(
    defineService({
      name,
      version: '0.1.0',
      dependencies: name === 'fraud-engine' ? ['postgres'] : [],
    }),
    {
      ATLAS_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: '0',
      READINESS_CHECK_TIMEOUT_MS: '500',
      ...env,
    },
  );
  running.push(peer as unknown as RunningService<never>);
  return peer.start();
}

describe('resolveServiceUrls', () => {
  it('defaults every catalogued service to its local development port', () => {
    const urls = resolveServiceUrls(undefined);
    expect(Object.keys(urls).sort()).toEqual([...serviceNames].sort());
    expect(urls['acs-core']).toBe('http://127.0.0.1:4001');
  });

  it('applies overrides and rejects unknown services or malformed URLs', () => {
    expect(resolveServiceUrls('acs-core=http://acs-core:4001')['acs-core']).toBe(
      'http://acs-core:4001',
    );
    expect(() => resolveServiceUrls('acs-cor=http://x:1')).toThrow(/unknown service/);
    expect(() => resolveServiceUrls('acs-core=ftp://x')).toThrow(/invalid URL/);
  });

  it('turns an invalid address book into a startup configuration error', async () => {
    await expect(startGateway({ ATLAS_SERVICE_URLS: 'nope=http://x:1' })).rejects.toThrow(
      /ATLAS_SERVICE_URLS/,
    );
  });
});

describe('platform health aggregation', () => {
  it('reports ready, not-ready and unreachable services as actually observed', async () => {
    const protocolUrl = await startPeer('protocol');
    const fraudUrl = await startPeer('fraud-engine', {
      DATABASE_URL: 'postgres://atlas:x@127.0.0.1:1/atlas',
    });
    const urls = resolveServiceUrls(
      `protocol=${protocolUrl},fraud-engine=${fraudUrl},acs-core=http://127.0.0.1:1`,
    );
    const data = await collectPlatformHealth({
      urls,
      self: 'api-gateway',
      timeoutMs: 1_500,
      correlationId: 'portal-req-0001',
    });
    const byName = Object.fromEntries(data.services.map((entry) => [entry.service, entry]));
    expect(byName.protocol).toMatchObject({ status: 'ready', version: '0.1.0' });
    expect(byName['fraud-engine']).toMatchObject({ status: 'not_ready' });
    expect(byName['fraud-engine']?.checks[0]).toMatchObject({ name: 'postgres', status: 'down' });
    expect(byName['acs-core']).toMatchObject({ status: 'unreachable', version: null });
    expect(data.services).toHaveLength(serviceNames.length);
  });

  it('marks a service unreachable when a different service answers on its address', async () => {
    const protocolUrl = await startPeer('protocol');
    const data = await collectPlatformHealth({
      urls: resolveServiceUrls(`visa-adapter=${protocolUrl}`),
      self: 'api-gateway',
      timeoutMs: 1_500,
      correlationId: 'portal-req-0002',
    });
    expect(data.services.find((entry) => entry.service === 'visa-adapter')?.status).toBe(
      'unreachable',
    );
  });
});

describe('authentication at the edge', () => {
  it('requires a session for the session endpoint, platform health and every API route', async () => {
    const gateway = await startGateway();
    for (const url of [
      '/v1/session',
      '/v1/platform/services',
      '/v1/tenants',
      '/v1/identity/me',
      '/v1/audit/events',
    ]) {
      const response = await gateway.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
      expect(problemDetailsSchema.parse(response.json()).code).toBe('UNAUTHENTICATED');
    }
  });

  it('never routes service-only endpoints', async () => {
    const gateway = await startGateway();
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/internal/principals/anyone',
    });
    expect(response.statusCode).toBe(404);
  });

  it('fails closed when the session store is unavailable', async () => {
    const gateway = await startGateway();
    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/session',
      // A well-formed id, so the gateway must consult the (unreachable) session store.
      headers: { cookie: `__Host-atlas_session=${SessionStore.newId()}` },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('fails closed, without authenticating, when Valkey is down and a well-formed cookie is sent', async () => {
    // Regression: the rate-limit identity lookup (sessions.isActive) must not turn an unavailable
    // store into a crash or into access; it falls back to the address and the request fails closed.
    const gateway = await startGateway();
    const cookie = `theme=dark; __Host-atlas_session=${SessionStore.newId()}`;
    const requests = [
      { method: 'GET', url: '/v1/session' },
      { method: 'GET', url: '/v1/tenants' },
      { method: 'PUT', url: '/v1/tenants/00000000-0000-4000-8000-000000000001/configuration' },
    ] as const;
    for (const { method, url } of requests) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await gateway.app.inject({
          method,
          url,
          headers: { cookie, 'content-type': 'application/json' },
          ...(method === 'PUT' ? { payload: {} } : {}),
        });
        expect(response.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(500);
        // A problem document only: no session data, no internal error detail.
        problemDetailsSchema.parse(response.json());
        expect(response.body).not.toMatch(/principal|csrfToken|ECONNREFUSED|stack/i);
        // Not mistaken for a missing session: the browser keeps its cookie for when Valkey returns.
        expect(String(response.headers['set-cookie'] ?? '')).not.toMatch(/atlas_session=;/);
      }
    }
  });

  it('refuses to start without its client secret or a valid session key', async () => {
    await expect(startGateway({ OIDC_CLIENT_SECRET: '' })).rejects.toThrow(/OIDC_CLIENT_SECRET/);
    await expect(startGateway({ SESSION_ENCRYPTION_KEY: 'short' })).rejects.toThrow(
      /SESSION_ENCRYPTION_KEY/,
    );
  });
});

describe('malformed cookies (final review F-12)', () => {
  // Each value is rejected by decodeURIComponent; before the fix any one of them in the Cookie
  // header made every gateway route answer 500, because the global rate-limit key parsed cookies.
  const malformed = ['%', '%E0%A4%A', '%zz', '%C0%AF'];

  it('ignores a malformed unrelated cookie instead of failing the request', async () => {
    const gateway = await startGateway();
    for (const value of malformed) {
      for (const url of ['/v1/session', '/v1/tenants', '/v1/unknown-route']) {
        const response = await gateway.app.inject({
          method: 'GET',
          url,
          headers: { cookie: `theme=${value}` },
        });
        expect(response.statusCode, `${url} with theme=${value}`).toBe(
          url === '/v1/unknown-route' ? 404 : 401,
        );
      }
    }
  });

  it('treats a malformed session cookie as no session, without consulting the store', async () => {
    // Valkey is unreachable here: a lookup would fail with 5xx, so 401 proves none was attempted.
    const gateway = await startGateway();
    for (const value of [...malformed, 'abc', `${SessionStore.newId()}x`, '../../etc']) {
      const response = await gateway.app.inject({
        method: 'GET',
        url: '/v1/session',
        headers: { cookie: `__Host-atlas_session=${value}` },
      });
      expect(response.statusCode, value).toBe(401);
      expect(problemDetailsSchema.parse(response.json()).code).toBe('UNAUTHENTICATED');
      expect(String(response.headers['set-cookie'])).toMatch(/^__Host-atlas_session=; .*Max-Age=0/);
    }
  });

  it('keeps sign-out and unauthenticated writes available with a malformed cookie', async () => {
    const gateway = await startGateway();
    const logout = await gateway.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: 'a=%; __Host-atlas_session=%E0%A4%A' },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ data: { endSessionUrl: null } });

    const write = await gateway.app.inject({
      method: 'PUT',
      url: '/v1/tenants/00000000-0000-4000-8000-000000000001/configuration',
      headers: { cookie: 'a=%', 'content-type': 'application/json' },
      payload: {},
    });
    expect(write.statusCode).toBe(401);
  });
});

describe('edge protections', () => {
  it('allows CORS only for configured portal origins', async () => {
    const gateway = await startGateway({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' });
    const allowed = await gateway.app.inject({
      method: 'OPTIONS',
      url: '/v1/session',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await gateway.app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { origin: 'https://evil.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate limits API routes with a RATE_LIMITED problem, but never health probes', async () => {
    const gateway = await startGateway({ RATE_LIMIT_MAX: '2' });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (await gateway.app.inject({ method: 'GET', url: '/v1/unknown-route' })).statusCode,
      );
    }
    expect(statuses).toEqual([404, 404, 429]);
    const limited = await gateway.app.inject({ method: 'GET', url: '/v1/unknown-route' });
    expect(problemDetailsSchema.parse(limited.json()).code).toBe('RATE_LIMITED');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await gateway.app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(
        200,
      );
    }
  });
});
