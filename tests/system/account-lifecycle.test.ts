import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEMO_PASSWORD,
  KEYCLOAK,
  MERIDIAN,
  PortalUser,
  SignInRefused,
  signedIn,
} from './client.js';

/**
 * Account lifecycle against the real identity provider:
 *  - disabling an account cuts off its existing session at once and refuses new sign-ins;
 *  - promoting an issuer user to a platform role grants no platform access without a second
 *    factor, and makes the provider demand TOTP enrolment at the next sign-in.
 *
 * Fresh synthetic accounts are created at Keycloak with a known password (through the
 * identity-service admin client), then linked to ATLAS by inviting the same address.
 */
const realmAdmin = `${KEYCLOAK}/admin/realms/atlas`;
const created: string[] = [];

async function adminToken(): Promise<string> {
  const response = await fetch(`${KEYCLOAK}/realms/atlas/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'atlas-svc-identity-service',
      client_secret: process.env.KEYCLOAK_CLIENT_SECRET_IDENTITY_SERVICE!,
    }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

async function idpUser(id: string) {
  const response = await fetch(`${realmAdmin}/users/${id}`, {
    headers: { authorization: `Bearer ${await adminToken()}` },
  });
  return (await response.json()) as { enabled: boolean; requiredActions: string[] };
}

/** A Keycloak account with a usable password and no pending actions, invited into Meridian. */
async function issuerAccount(label: string) {
  const email = `${label}.${randomBytes(4).toString('hex')}@meridian.test`;
  const response = await fetch(`${realmAdmin}/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: email,
      email,
      emailVerified: true,
      enabled: true,
      firstName: 'Synthetic',
      lastName: label,
      credentials: [{ type: 'password', value: DEMO_PASSWORD, temporary: false }],
      requiredActions: [],
    }),
  });
  expect(response.status).toBe(201);
  const subject = response.headers.get('location')!.split('/').at(-1)!;
  created.push(subject);
  const admin = await signedIn('super.admin@atlas.test');
  const invited = await admin.api('POST', `/v1/tenants/${MERIDIAN}/users`, {
    email,
    displayName: `Synthetic ${label}`,
    roles: ['reporting-user'],
  });
  expect(invited.status).toBe(201);
  const user = new PortalUser();
  await user.signIn(email);
  return { email, subject, user, userId: invited.body.data.id as string };
}

afterAll(async () => {
  const token = await adminToken();
  for (const id of created) {
    await fetch(`${realmAdmin}/users/${id}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    }).catch(() => undefined);
  }
});

describe('account lifecycle', () => {
  it('disabling an account ends its access immediately and refuses new sign-ins', async () => {
    const account = await issuerAccount('disabled');
    expect((await account.user.api('GET', `/v1/tenants/${MERIDIAN}`)).status).toBe(200);

    const admin = await signedIn('super.admin@atlas.test');
    const disabled = await admin.api('POST', `/v1/identity/users/${account.userId}/status`, {
      status: 'disabled',
      reason: 'system test: account disabled',
    });
    expect(disabled.status).toBe(200);
    expect((await idpUser(account.subject)).enabled).toBe(false);

    // The services see the disabled principal (cache ≤ 10 s); the gateway then drops the session.
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    expect((await account.user.api('GET', `/v1/tenants/${MERIDIAN}`)).status).toBe(403);
    expect((await account.user.session()).status).toBe(401);
    expect((await account.user.api('GET', `/v1/tenants/${MERIDIAN}`)).status).toBe(401);
    await expect(new PortalUser().signIn(account.email)).rejects.toBeInstanceOf(SignInRefused);
  });

  it('a user promoted to a platform role gets no platform access until a second factor is enrolled', async () => {
    const account = await issuerAccount('promoted');
    const admin = await signedIn('super.admin@atlas.test');
    const promoted = await admin.api('PUT', `/v1/identity/platform-users/${account.userId}/roles`, {
      roles: ['technical-administrator'],
    });
    expect(promoted.status).toBe(200);
    expect((await idpUser(account.subject)).requiredActions).toContain('CONFIGURE_TOTP');

    // The password-only session holds no platform permission, in the gateway or the services.
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const session = await account.user.session();
    if (session.status === 200) {
      expect(session.body.data.principal.platformPermissions).toEqual([]);
      expect((await account.user.api('GET', '/v1/audit/events')).status).toBe(403);
    } else {
      expect(session.status).toBe(401); // the provider already ended the session
    }

    // The next sign-in stops at TOTP enrolment instead of completing with a password alone.
    const refused = await new PortalUser().signIn(account.email).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SignInRefused);
    expect((refused as SignInRefused).page).toMatch(/totp|authenticator/i);
  });
});
