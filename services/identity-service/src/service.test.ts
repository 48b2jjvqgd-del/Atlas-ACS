import { readinessResponseSchema, serviceCatalog } from '@atlas/contracts';
import { createService } from '@atlas/service-kit';
import { createTestIssuer, staticPrincipals, TEST_ISSUER } from '@atlas/service-kit/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { definition } from './service.js';

// Unreachable infrastructure: proves the service starts, declares an access policy on every
// route (deny by default, enforced at startup) and reports health without its dependencies.
const env = {
  ATLAS_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '0',
  READINESS_CHECK_TIMEOUT_MS: '1500',
  DATABASE_URL: 'postgres://atlas:test@127.0.0.1:1/atlas',
  RABBITMQ_URL: 'amqp://atlas:test@127.0.0.1:1',
  OIDC_ISSUER_URL: TEST_ISSUER,
  SERVICE_CLIENT_SECRET: 'test-client-secret-0123456789',
  IDP_ADMIN_ENABLED: 'false',
};

let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
beforeAll(async () => {
  issuer = await createTestIssuer();
});

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.stop()));
});

async function start() {
  const service = await createService(definition, env, {
    overrides: {
      keySet: issuer.keySet,
      principals: staticPrincipals({}),
      tokens: issuer.tokenProvider('identity-service'),
    },
  });
  running.push(service);
  return service;
}

describe('identity-service', () => {
  it('starts on a real socket and reports liveness and metadata', async () => {
    const service = await start();
    const address = await service.start();
    const live = await fetch(`${address}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', service: 'identity-service' });
    const info = await (await fetch(`${address}/info`)).json();
    expect(info).toMatchObject({ service: 'identity-service', version: definition.version });
  });

  it('declares only the infrastructure its catalogue entry allows it to own', () => {
    const { dataStores } = serviceCatalog['identity-service'];
    expect(definition.dependencies.includes('postgres')).toBe(dataStores.postgresSchema !== null);
  });

  it('reports readiness for each declared dependency', async () => {
    const service = await start();
    const response = await service.app.inject({ method: 'GET', url: '/health/ready' });
    const body = readinessResponseSchema.parse(response.json());
    expect(body.checks.map((check) => check.name).sort()).toEqual([
      'authorisation-catalogue',
      'postgres',
      'rabbitmq',
    ]);
    expect(response.statusCode).toBe(503);
  });

  it('rejects application requests without a service token', async () => {
    const service = await start();
    const anonymous = await service.app.inject({ method: 'GET', url: '/v1/identity/me' });
    expect(anonymous.statusCode).toBe(401);
    // A valid service token but no user token is still refused on a user route.
    const serviceOnly = await service.app.inject({
      method: 'GET',
      url: '/v1/identity/me',
      headers: {
        authorization: `Bearer ${await issuer.serviceToken('api-gateway', 'identity-service')}`,
      },
    });
    expect(serviceOnly.statusCode).toBe(401);
    expect(serviceOnly.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      detail: 'User token required',
    });
  });

  it('requires identity-provider settings', async () => {
    await expect(createService(definition, { ...env, OIDC_ISSUER_URL: '' })).rejects.toThrow(
      /OIDC_ISSUER_URL/,
    );
  });
});
