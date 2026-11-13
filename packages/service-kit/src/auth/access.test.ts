import { problemDetailsSchema } from '@atlas/contracts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createService, type RunningService } from '../runtime.js';
import { defineService } from '../service.js';
import {
  createTestIssuer,
  principal,
  staticPrincipals,
  TEST_ISSUER,
  type TestIssuer,
} from '../testing/index.js';
import type { AccessDeniedEvent } from './access.js';

const TENANT_A = '1a2b0000-0000-4000-8000-00000000000a';
const TENANT_B = '1a2b0000-0000-4000-8000-00000000000b';

const principals = staticPrincipals({
  'tenant-a-admin': principal({
    userId: '7c000000-0000-4000-8000-0000000000a1',
    tenants: [
      {
        tenantId: TENANT_A,
        roles: ['issuer-administrator'],
        permissions: ['issuer.read', 'issuer.configuration.manage'],
      },
    ],
  }),
  'tenant-a-support': principal({
    userId: '7c000000-0000-4000-8000-0000000000a2',
    tenants: [{ tenantId: TENANT_A, roles: ['customer-support'], permissions: ['issuer.read'] }],
  }),
  'platform-admin': principal({
    userId: '7c000000-0000-4000-8000-0000000000p1',
    platformRoles: ['platform-administrator'],
    platformPermissions: ['issuer.read', 'issuer.create'],
  }),
  disabled: principal({
    userId: '7c000000-0000-4000-8000-0000000000d1',
    status: 'disabled',
    platformPermissions: ['issuer.read'],
  }),
});

let issuer: TestIssuer;
const denied: AccessDeniedEvent[] = [];
const running: RunningService<Record<never, never>>[] = [];

beforeAll(async () => {
  issuer = await createTestIssuer();
});
afterEach(async () => {
  denied.length = 0;
  await Promise.all(running.splice(0).map((service) => service.stop()));
});

const testService = defineService({
  name: 'issuer-service',
  version: '0.0.0',
  dependencies: [],
  security: { verifyTokens: true, onDenied: () => async (event) => void denied.push(event) },
  register(app) {
    app.get('/v1/things', { config: { access: { kind: 'user' } } }, async (request) => ({
      tenants: request.authz!.tenantIds('issuer.read'),
    }));
    app.post(
      '/v1/things',
      { config: { access: { kind: 'user', permission: 'issuer.create' } } },
      async () => ({ ok: true }),
    );
    app.get(
      '/v1/tenants/:tenantId/thing',
      { config: { access: { kind: 'user', permission: 'issuer.read', tenantParam: 'tenantId' } } },
      async () => ({ ok: true }),
    );
    app.put(
      '/v1/tenants/:tenantId/configuration',
      {
        config: {
          access: {
            kind: 'user',
            permission: 'issuer.configuration.manage',
            tenantParam: 'tenantId',
          },
        },
      },
      async () => ({ ok: true }),
    );
    app.get(
      '/v1/internal/thing',
      { config: { access: { kind: 'service', callers: ['identity-service'] } } },
      async (request) => ({
        caller: request.caller,
      }),
    );
  },
});

async function start() {
  const service = await createService(
    testService,
    { ATLAS_ENV: 'test', LOG_LEVEL: 'silent', PORT: '0', OIDC_ISSUER_URL: TEST_ISSUER },
    { overrides: { keySet: issuer.keySet, principals } },
  );
  running.push(service as unknown as RunningService<Record<never, never>>);
  return service;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  options: { service?: string | null; user?: string | null } = {},
) {
  const service = await start();
  const headers: Record<string, string> = {};
  const serviceToken =
    options.service === undefined
      ? await issuer.serviceToken('api-gateway', 'issuer-service')
      : options.service;
  if (serviceToken) headers.authorization = `Bearer ${serviceToken}`;
  if (options.user) headers['x-atlas-user-token'] = options.user;
  const response = await service.app.inject({ method, url, headers });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe('deny by default', () => {
  it('refuses to start when an application route declares no access policy', async () => {
    const unsafe = defineService({
      name: 'issuer-service',
      version: '0.0.0',
      dependencies: [],
      security: { verifyTokens: true },
      register(app) {
        app.get('/v1/forgotten', async () => ({}));
      },
    });
    await expect(
      createService(
        unsafe,
        { ATLAS_ENV: 'test', LOG_LEVEL: 'silent', OIDC_ISSUER_URL: TEST_ISSUER },
        { overrides: { keySet: issuer.keySet, principals } },
      ),
    ).rejects.toThrow(/declares no access policy/);
  });

  it('leaves infrastructure endpoints open for orchestrators', async () => {
    const service = await start();
    expect((await service.app.inject({ url: '/health/live' })).statusCode).toBe(200);
  });
});

describe('service authentication', () => {
  it('rejects requests without a service token', async () => {
    const { status, body } = await call('GET', '/v1/things', {
      service: null,
      user: await issuer.userToken('tenant-a-admin'),
    });
    expect(status).toBe(401);
    expect(problemDetailsSchema.parse(body).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token signed by another key, an expired token and a token for another service', async () => {
    const user = await issuer.userToken('tenant-a-admin');
    expect(
      (await call('GET', '/v1/things', { service: await issuer.forgedToken('x'), user })).status,
    ).toBe(401);
    expect(
      (
        await call('GET', '/v1/things', {
          service: await issuer.serviceToken('api-gateway', 'issuer-service', { expiresIn: -60 }),
          user,
        })
      ).status,
    ).toBe(401);
    const forAudit = await issuer.serviceToken('api-gateway', 'audit-service');
    const wrongAudience = await call('GET', '/v1/things', { service: forAudit, user });
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.body.detail).toBe('Token audience is not accepted');
  });

  it('rejects a user token presented as a service token', async () => {
    const user = await issuer.userToken('tenant-a-admin');
    expect((await call('GET', '/v1/things', { service: user, user })).status).toBe(401);
  });

  it('allows only the declared calling services on a route', async () => {
    const asGateway = await call('GET', '/v1/internal/thing');
    expect(asGateway.status).toBe(403);
    expect(denied[0]?.reason).toBe('caller-not-allowed');
    const asIdentity = await call('GET', '/v1/internal/thing', {
      service: await issuer.serviceToken('identity-service', 'issuer-service'),
    });
    expect(asIdentity).toEqual({ status: 200, body: { caller: 'identity-service' } });
  });
});

describe('user authentication and authorisation', () => {
  it('requires a valid user token on user routes', async () => {
    expect((await call('GET', '/v1/things')).status).toBe(401);
    expect(
      (await call('GET', '/v1/things', { user: await issuer.forgedToken('tenant-a-admin') }))
        .status,
    ).toBe(401);
    expect(
      (
        await call('GET', '/v1/things', {
          user: await issuer.userToken('tenant-a-admin', { expiresIn: -60 }),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call('GET', '/v1/things', {
          user: await issuer.userToken('tenant-a-admin', { azp: 'some-other-client' }),
        })
      ).status,
    ).toBe(401);
  });

  it('denies users without an active ATLAS account', async () => {
    expect(
      (await call('GET', '/v1/things', { user: await issuer.userToken('nobody') })).status,
    ).toBe(403);
    expect(
      (
        await call('GET', '/v1/things', {
          user: await issuer.userToken('disabled', { amr: ['pwd', 'otp'] }),
        })
      ).status,
    ).toBe(403);
    expect(denied.map((event) => event.reason)).toEqual(['no-account', 'no-account']);
  });

  it('derives tenant context from the principal, not the request', async () => {
    const { body } = await call('GET', '/v1/things', {
      user: await issuer.userToken('tenant-a-admin'),
    });
    expect(body.tenants).toEqual([TENANT_A]);
  });

  it('returns 404 (not 403) for another tenant, so its existence is not disclosed', async () => {
    const user = await issuer.userToken('tenant-a-admin');
    expect((await call('GET', `/v1/tenants/${TENANT_A}/thing`, { user })).status).toBe(200);
    const other = await call('GET', `/v1/tenants/${TENANT_B}/thing`, { user });
    expect(other.status).toBe(404);
    expect(denied.at(-1)).toMatchObject({ reason: 'tenant-not-accessible', tenantId: TENANT_B });
  });

  it('returns 403 inside the user’s own tenant when the permission is missing', async () => {
    const support = await issuer.userToken('tenant-a-support');
    expect(
      (await call('PUT', `/v1/tenants/${TENANT_A}/configuration`, { user: support })).status,
    ).toBe(403);
    expect(denied.at(-1)).toMatchObject({
      reason: 'forbidden',
      permission: 'issuer.configuration.manage',
    });
  });

  it('treats a malformed tenant id as not found', async () => {
    const user = await issuer.userToken('tenant-a-admin');
    expect((await call('GET', '/v1/tenants/not-a-uuid/thing', { user })).status).toBe(404);
  });

  it('never lets tenant permissions satisfy a platform-wide check', async () => {
    const user = await issuer.userToken('tenant-a-admin');
    expect((await call('POST', '/v1/things', { user })).status).toBe(403);
  });

  it('honours platform permissions only when the sign-in used a second factor', async () => {
    const withoutMfa = await issuer.userToken('platform-admin', { amr: ['pwd'] });
    expect((await call('POST', '/v1/things', { user: withoutMfa })).status).toBe(403);
    expect((await call('GET', `/v1/tenants/${TENANT_B}/thing`, { user: withoutMfa })).status).toBe(
      404,
    );

    const withMfa = await issuer.userToken('platform-admin', { amr: ['pwd', 'otp'] });
    expect((await call('POST', '/v1/things', { user: withMfa })).status).toBe(200);
    expect((await call('GET', `/v1/tenants/${TENANT_B}/thing`, { user: withMfa })).status).toBe(
      200,
    );
    const listed = await call('GET', '/v1/things', { user: withMfa });
    expect(listed.body.tenants).toBe('all');
  });
});
