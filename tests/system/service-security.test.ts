import { describe, expect, it } from 'vitest';
import { NORTHSTAR, signedIn } from './client.js';

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
});
