import { describe, expect, it } from 'vitest';
import { MERIDIAN, NORTHSTAR, signedIn } from './client.js';

/**
 * Role matrix against the real stack: each seeded role gets exactly the access its permissions
 * imply, enforced by the services (the portal is not involved).
 */
type Expect = Record<string, number>;
const cases: Record<string, Expect> = {
  'super.admin@atlas.test': {
    [`GET /v1/tenants/${MERIDIAN}`]: 200,
    'GET /v1/identity/platform-users': 200,
    'GET /v1/audit/events?limit=1': 200,
    'GET /v1/platform/services': 200,
  },
  'tech.admin@atlas.test': {
    [`GET /v1/tenants/${NORTHSTAR}`]: 200,
    'GET /v1/platform/services': 200,
    'GET /v1/identity/platform-users': 403,
    [`GET /v1/tenants/${NORTHSTAR}/users`]: 403,
    [`PUT /v1/tenants/${NORTHSTAR}/configuration`]: 403,
  },
  'admin@northstar.test': {
    [`GET /v1/tenants/${NORTHSTAR}/configuration`]: 200,
    [`GET /v1/tenants/${NORTHSTAR}/users`]: 200,
    [`GET /v1/tenants/${NORTHSTAR}/audit/events?limit=1`]: 200,
    'GET /v1/identity/platform-users': 403,
    'GET /v1/audit/events?limit=1': 403,
    'POST /v1/tenants': 403,
    [`POST /v1/tenants/${NORTHSTAR}/status`]: 403,
    'GET /v1/platform/services': 403,
  },
  'reporting@northstar.test': {
    [`GET /v1/tenants/${NORTHSTAR}`]: 200,
    [`GET /v1/tenants/${NORTHSTAR}/configuration`]: 403,
    [`PUT /v1/tenants/${NORTHSTAR}/configuration`]: 403,
    [`GET /v1/tenants/${NORTHSTAR}/users`]: 403,
  },
  'support@northstar.test': {
    [`GET /v1/tenants/${NORTHSTAR}`]: 200,
    [`PUT /v1/tenants/${NORTHSTAR}/configuration`]: 403,
    [`POST /v1/tenants/${NORTHSTAR}/users`]: 403,
    [`GET /v1/tenants/${NORTHSTAR}/audit/events`]: 403,
  },
  'compliance@northstar.test': {
    [`GET /v1/tenants/${NORTHSTAR}/audit/events?limit=1`]: 200,
    [`PUT /v1/tenants/${NORTHSTAR}/configuration`]: 403,
  },
  'fraud.analyst@northstar.test': {
    [`GET /v1/tenants/${NORTHSTAR}`]: 200,
    [`GET /v1/tenants/${NORTHSTAR}/users`]: 403,
  },
};

const bodies: Record<string, unknown> = {
  'PUT configuration': { expectedVersion: 1, settings: {} },
  'POST users': {
    email: 'nobody@northstar.test',
    displayName: 'Nobody',
    roles: ['reporting-user'],
  },
  'POST status': { status: 'suspended', reason: 'permission test' },
  'POST tenants': { slug: 'perm-test', displayName: 'Perm Test', internalReference: 'PERM-1' },
};

describe('role-based access control (backend-enforced)', () => {
  for (const [email, expectations] of Object.entries(cases)) {
    it(`${email} has exactly the intended access`, async () => {
      const user = await signedIn(email);
      for (const [request, status] of Object.entries(expectations)) {
        const [method, path] = request.split(' ') as [string, string];
        const key = `${method} ${path.split('/').at(-1)}`;
        const body = method === 'GET' ? undefined : (bodies[key] ?? {});
        const response = await user.api(method, path, body);
        expect(response.status, `${email}: ${request}`).toBe(status);
      }
    });
  }

  it('reports the same permissions to the portal as the services enforce', async () => {
    const user = await signedIn('support@northstar.test');
    const { body } = await user.session();
    expect(body.data.principal.tenants[0].permissions).toEqual([
      'authentication.read',
      'issuer.read',
    ]);
  });
});
