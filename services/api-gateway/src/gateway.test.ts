import {
  platformServicesResponseSchema,
  problemDetailsSchema,
  serviceNames,
} from '@atlas/contracts';
import { createService, defineService, type RunningService } from '@atlas/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveServiceUrls } from './registry.js';
import { definition } from './service.js';

const running: RunningService<never>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.stop()));
});

async function startGateway(env: Record<string, string> = {}) {
  const gateway = await createService(definition, {
    ATLAS_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: '0',
    ...env,
  });
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

describe('GET /v1/platform/services', () => {
  it('reports ready, not-ready and unreachable services as actually observed', async () => {
    const protocolUrl = await startPeer('protocol');
    const fraudUrl = await startPeer('fraud-engine', {
      DATABASE_URL: 'postgres://atlas:x@127.0.0.1:1/atlas',
    });
    const gateway = await startGateway({
      ATLAS_SERVICE_URLS: `protocol=${protocolUrl},fraud-engine=${fraudUrl},acs-core=http://127.0.0.1:1`,
      HEALTH_PROBE_TIMEOUT_MS: '1500',
    });

    const response = await gateway.app.inject({
      method: 'GET',
      url: '/v1/platform/services',
      headers: { 'x-correlation-id': 'portal-req-0001' },
    });
    expect(response.statusCode).toBe(200);
    const body = platformServicesResponseSchema.parse(response.json());
    expect(body.meta.correlationId).toBe('portal-req-0001');

    const byName = Object.fromEntries(body.data.services.map((entry) => [entry.service, entry]));
    expect(byName.protocol).toMatchObject({ status: 'ready', version: '0.1.0' });
    expect(byName['fraud-engine']).toMatchObject({ status: 'not_ready' });
    expect(byName['fraud-engine']?.checks[0]).toMatchObject({ name: 'postgres', status: 'down' });
    expect(byName['acs-core']).toMatchObject({ status: 'unreachable', version: null });
    expect(body.data.services).toHaveLength(serviceNames.length);
  });

  it('marks a service unreachable when a different service answers on its address', async () => {
    const protocolUrl = await startPeer('protocol');
    const gateway = await startGateway({ ATLAS_SERVICE_URLS: `visa-adapter=${protocolUrl}` });
    const body = platformServicesResponseSchema.parse(
      (await gateway.app.inject({ method: 'GET', url: '/v1/platform/services' })).json(),
    );
    expect(body.data.services.find((entry) => entry.service === 'visa-adapter')?.status).toBe(
      'unreachable',
    );
  });
});

describe('edge protections', () => {
  it('allows CORS only for configured portal origins', async () => {
    const gateway = await startGateway({ CORS_ALLOWED_ORIGINS: 'http://localhost:5173' });
    const allowed = await gateway.app.inject({
      method: 'OPTIONS',
      url: '/v1/platform/services',
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
