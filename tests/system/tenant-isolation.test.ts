import { describe, expect, it } from 'vitest';
import { MERIDIAN, NORTHSTAR, signedIn } from './client.js';

/**
 * Cross-tenant access: a principal of one issuer receives 404 for every resource of another,
 * on every tenant-scoped endpoint and method, and tenant ids supplied anywhere else in the
 * request do not widen access. New tenant-scoped endpoints must be added here.
 */
const endpoints = (tenant: string): [string, string, unknown?][] => [
  ['GET', `/v1/tenants/${tenant}`],
  ['PATCH', `/v1/tenants/${tenant}`, { displayName: 'Hijacked' }],
  ['POST', `/v1/tenants/${tenant}/status`, { status: 'suspended', reason: 'cross-tenant attempt' }],
  ['GET', `/v1/tenants/${tenant}/configuration`],
  ['PUT', `/v1/tenants/${tenant}/configuration`, { expectedVersion: 1, settings: {} }],
  ['GET', `/v1/tenants/${tenant}/users`],
  [
    'POST',
    `/v1/tenants/${tenant}/users`,
    { email: 'intruder@northstar.test', displayName: 'Intruder', roles: ['reporting-user'] },
  ],
  [
    'PUT',
    `/v1/tenants/${tenant}/users/7c000000-0000-4000-8000-000000000022/roles`,
    { roles: ['reporting-user'] },
  ],
  ['DELETE', `/v1/tenants/${tenant}/users/7c000000-0000-4000-8000-000000000022`],
  ['GET', `/v1/tenants/${tenant}/audit/events`],
];

describe('tenant isolation', () => {
  for (const [who, home, other] of [
    ['admin@northstar.test', NORTHSTAR, MERIDIAN],
    ['admin@meridian.test', MERIDIAN, NORTHSTAR],
  ] as const) {
    it(`${who} cannot reach any resource of the other issuer (404, nothing changes)`, async () => {
      const user = await signedIn(who);
      for (const [method, path, body] of endpoints(other)) {
        const response = await user.api(method, path, body);
        expect(response.status, `${method} ${path}`).toBe(404);
      }
      // and can reach their own
      expect((await user.api('GET', `/v1/tenants/${home}`)).status).toBe(200);
    });

    it(`${who} sees only their own issuer in every listing`, async () => {
      const user = await signedIn(who);
      const list = await user.api('GET', '/v1/tenants?limit=200');
      expect(list.body.data.map((t: { id: string }) => t.id)).toEqual([home]);
      const users = await user.api('GET', `/v1/tenants/${home}/users`);
      for (const u of users.body.data as { tenantId: string }[]) expect(u.tenantId).toBe(home);
      const audit = await user.api('GET', `/v1/tenants/${home}/audit/events?limit=200`);
      for (const record of audit.body.data as { tenantId: string | null }[])
        expect(record.tenantId).toBe(home);
    });
  }

  it('ignores tenant ids tampered into query strings and bodies', async () => {
    const user = await signedIn('admin@northstar.test');
    // The issuer audit route is pinned to the path tenant; a query tenantId cannot redirect it.
    const audit = await user.api(
      'GET',
      `/v1/tenants/${NORTHSTAR}/audit/events?tenantId=${MERIDIAN}&limit=200`,
    );
    expect(audit.status).toBe(200);
    for (const record of audit.body.data as { tenantId: string }[])
      expect(record.tenantId).toBe(NORTHSTAR);
    // The platform-wide audit route is not available to issuer users at all.
    expect((await user.api('GET', `/v1/audit/events?tenantId=${NORTHSTAR}`)).status).toBe(403);
    // Unknown body fields (e.g. a tenantId) are rejected by strict schemas.
    const config = await user.api('GET', `/v1/tenants/${NORTHSTAR}/configuration`);
    const tampered = await user.api('PUT', `/v1/tenants/${NORTHSTAR}/configuration`, {
      expectedVersion: config.body.data.version,
      settings: config.body.data.settings,
      tenantId: MERIDIAN,
    });
    expect(tampered.status).toBe(400);
  });

  it('cannot read another issuer’s audit record by id', async () => {
    const meridian = await signedIn('admin@meridian.test');
    const own = await meridian.api('GET', `/v1/tenants/${MERIDIAN}/audit/events?limit=1`);
    const northstar = await signedIn('admin@northstar.test');
    if (own.body.data.length > 0) {
      expect((await northstar.api('GET', `/v1/audit/events/${own.body.data[0].id}`)).status).toBe(
        404,
      );
    }
  });

  it('issuer administrators cannot reach platform administration', async () => {
    const user = await signedIn('admin@northstar.test');
    for (const [method, path] of [
      ['GET', '/v1/identity/platform-users'],
      ['POST', '/v1/identity/roles'],
      ['GET', '/v1/audit/events'],
      ['POST', '/v1/tenants'],
      ['GET', '/v1/platform/services'],
    ] as const) {
      const response = await user.api(method, path, method === 'POST' ? {} : undefined);
      // 403, not 400: authorisation runs before input validation.
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});
