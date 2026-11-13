import { problemDetailsSchema, serviceNames } from '@atlas/contracts';
import { createService, defineService, type RunningService } from '@atlas/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { collectPlatformHealth } from './platform-health.js';
import { resolveServiceUrls } from './registry.js';
import { definition } from './service.js';

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
      headers: { cookie: '__Host-atlas_session=abc' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('refuses to start without its client secret or a valid session key', async () => {
    await expect(startGateway({ OIDC_CLIENT_SECRET: '' })).rejects.toThrow(/OIDC_CLIENT_SECRET/);
    await expect(startGateway({ SESSION_ENCRYPTION_KEY: 'short' })).rejects.toThrow(
      /SESSION_ENCRYPTION_KEY/,
    );
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
