import { request as httpRequest } from 'node:http';
import { describe, expect, it } from 'vitest';
import { NORTHSTAR, PORTAL, signedIn } from './client.js';

/**
 * Service-to-service security, exercised directly against each service (bypassing the gateway)
 * with real tokens from the local identity provider.
 */
const KEYCLOAK = process.env.SYSTEM_TEST_KEYCLOAK_URL ?? 'http://localhost:8180';
const SERVICE = {
  issuer: process.env.SYSTEM_TEST_ISSUER_URL ?? 'http://127.0.0.1:4008',
  identity: process.env.SYSTEM_TEST_IDENTITY_URL ?? 'http://127.0.0.1:4010',
  audit: process.env.SYSTEM_TEST_AUDIT_URL ?? 'http://127.0.0.1:4012',
};

async function serviceToken(
  caller: string,
  audience: string,
): Promise<{ status: number; token?: string; error?: string }> {
  const secret =
    process.env[`KEYCLOAK_CLIENT_SECRET_${caller.replaceAll('-', '_').toUpperCase()}`]!;
  const response = await fetch(`${KEYCLOAK}/realms/atlas/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: `atlas-svc-${caller}`,
      client_secret: secret,
      scope: `aud-${audience}`,
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  return {
    status: response.status,
    ...(body.access_token ? { token: body.access_token } : {}),
    ...(body.error ? { error: body.error } : {}),
  };
}

const GATEWAY = process.env.SYSTEM_TEST_GATEWAY_URL ?? 'http://127.0.0.1:4000';

/** A request whose path is sent exactly as written (fetch would normalise dot segments). */
function rawGet(base: string, path: string, headers: Record<string, string>) {
  const url = new URL(base);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const call = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => undefined)) as { code?: string; detail?: string },
  }));

describe('service-to-service security', () => {
  it('rejects unauthenticated service requests', async () => {
    for (const [base, path] of [
      [SERVICE.issuer, '/v1/tenants'],
      [SERVICE.identity, '/v1/internal/principals/anyone'],
      [SERVICE.audit, '/v1/audit/events'],
    ] as const) {
      const response = await call(base, path);
      expect(response.status, path).toBe(401);
    }
  });

  it('rejects malformed and forged tokens', async () => {
    expect(
      (await call(SERVICE.issuer, '/v1/tenants', { authorization: 'Bearer not-a-token' })).status,
    ).toBe(401);
    const real = await serviceToken('api-gateway', 'issuer-service');
    const [header, payload] = real.token!.split('.');
    const forged = `${header}.${payload}.${Buffer.from('forged-signature').toString('base64url')}`;
    const response = await call(SERVICE.issuer, '/v1/tenants', {
      authorization: `Bearer ${forged}`,
    });
    expect(response.status).toBe(401);
    expect(response.body.detail).toBe('Token signature is invalid');
  });

  it('rejects a valid token issued for a different service', async () => {
    const forIdentity = await serviceToken('api-gateway', 'identity-service');
    const response = await call(SERVICE.issuer, '/v1/tenants', {
      authorization: `Bearer ${forIdentity.token}`,
    });
    expect(response.status).toBe(401);
    expect(response.body.detail).toBe('Token audience is not accepted');
  });

  it('enforces which services may call which (identity provider and callee both)', async () => {
    // The provider refuses audiences a service was never granted.
    expect(await serviceToken('audit-service', 'issuer-service')).toMatchObject({
      status: 400,
      error: 'invalid_scope',
    });
    // A granted token still only opens the routes that list its caller.
    const identityToIssuer = await serviceToken('identity-service', 'issuer-service');
    const user = await signedIn('admin@northstar.test');
    void user;
    const userRoute = await call(SERVICE.issuer, `/v1/tenants/${NORTHSTAR}`, {
      authorization: `Bearer ${identityToIssuer.token}`,
    });
    expect(userRoute.status).toBe(403);
    const internal = await call(SERVICE.issuer, `/v1/internal/tenants/${NORTHSTAR}`, {
      authorization: `Bearer ${identityToIssuer.token}`,
    });
    expect(internal.status).toBe(200);
    const gatewayToIssuer = await serviceToken('api-gateway', 'issuer-service');
    expect(
      (
        await call(SERVICE.issuer, `/v1/internal/tenants/${NORTHSTAR}`, {
          authorization: `Bearer ${gatewayToIssuer.token}`,
        })
      ).status,
    ).toBe(403);
  });

  it('requires a user token on user routes even with a valid service token', async () => {
    const token = await serviceToken('api-gateway', 'issuer-service');
    const response = await call(SERVICE.issuer, '/v1/tenants', {
      authorization: `Bearer ${token.token}`,
    });
    expect(response).toMatchObject({ status: 401, body: { detail: 'User token required' } });
  });

  it('never forwards a non-canonical path to a service with the gateway’s identity', async () => {
    // Directly at the gateway (no nginx in front to normalise the path): a signed-in issuer user
    // tries to reach identity-service's service-only principal lookup, which accepts the gateway.
    const user = await signedIn('support@meridian.test');
    const host = new URL(PORTAL).host;
    const cookie = [...user.cookies]
      .filter(([key]) => key.startsWith(`${host}|`))
      .map(([key, value]) => `${key.split('|')[1]}=${value}`)
      .join('; ');
    const subject = '5ab00000-0000-4000-8000-000000000001';
    for (const path of [
      `/v1/tenants/x/users/../../../internal/principals/${subject}`,
      `/v1/tenants/x/users/%2e%2e/%2e%2e/%2e%2e/internal/principals/${subject}`,
      `/v1/tenants/x/users/..%2f..%2f..%2finternal/principals/${subject}`,
      `/v1/internal/principals/${subject}`,
    ]) {
      const response = await rawGet(GATEWAY, path, { cookie, host });
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain('super.admin@atlas.test');
    }
  });
});
