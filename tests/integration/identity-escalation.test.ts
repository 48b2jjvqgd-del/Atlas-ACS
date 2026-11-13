import { randomBytes, randomUUID } from 'node:crypto';
import {
  permissionAllowsScope,
  permissionKeys,
  type Permission,
  type Principal,
} from '@atlas/contracts';
import { createIdentityService } from '@atlas/identity-service/service';
import { createService } from '@atlas/service-kit';
import {
  createTestIssuer,
  principal,
  staticPrincipals,
  TEST_ISSUER,
} from '@atlas/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from './database.js';
import { infrastructure } from './env.js';

/**
 * Privilege-escalation guards in identity-service, against a real database:
 *  - nobody changes their own privileges, through any endpoint (including "invite" of oneself);
 *  - platform user and role administration is capped at the caller's own platform permissions;
 *  - a user promoted to platform roles must enrol a second factor, and their sessions are ended.
 */
let db: TestDatabase;
let tokens: Awaited<ReturnType<typeof createTestIssuer>>;
let service: Awaited<ReturnType<typeof createService>>;
const TENANT = randomUUID();
const ids = {
  superAdmin: randomUUID(),
  issuerUser: randomUUID(),
  userManager: randomUUID(),
  roleManager: randomUUID(),
  issuerAdmin: randomUUID(),
};
const suffix = randomBytes(3).toString('hex');
const idpCalls: string[] = [];

const allPlatform = permissionKeys.filter((p) => permissionAllowsScope(p, 'platform'));
const actors: Record<string, Principal> = {
  [ids.superAdmin]: principal({
    userId: ids.superAdmin,
    email: `sa.${suffix}@escalation.test`,
    platformRoles: ['platform-super-admin'],
    platformPermissions: allPlatform,
  }),
  [ids.userManager]: principal({
    userId: ids.userManager,
    email: `um.${suffix}@escalation.test`,
    platformRoles: [`user-manager-${suffix}`],
    platformPermissions: ['platform.users.read', 'platform.users.manage'],
  }),
  [ids.roleManager]: principal({
    userId: ids.roleManager,
    email: `rm.${suffix}@escalation.test`,
    platformRoles: [`role-manager-${suffix}`],
    platformPermissions: ['platform.roles.manage'],
  }),
  [ids.issuerAdmin]: principal({
    userId: ids.issuerAdmin,
    email: `ia.${suffix}@escalation.test`,
    tenants: [
      {
        tenantId: TENANT,
        roles: ['issuer-administrator'],
        permissions: ['issuer.read', 'issuer.users.read', 'issuer.users.manage'] as Permission[],
      },
    ],
  }),
};

beforeAll(async () => {
  db = await createTestDatabase('escalation');
  tokens = await createTestIssuer();
  await withClient(db.migratorUrl, async (client) => {
    for (const [key, permissions] of [
      [`user-manager-${suffix}`, ['platform.users.read', 'platform.users.manage']],
      [`role-manager-${suffix}`, ['platform.roles.manage']],
    ] as const) {
      await client.query(
        `INSERT INTO identity.role (key, scope, name, permissions) VALUES ($1, 'platform', $1, $2)`,
        [key, permissions],
      );
    }
    for (const actor of Object.values(actors)) {
      await client.query(
        `INSERT INTO identity.user_account (id, idp_subject, email, display_name, status) VALUES ($1, $2, $3, 'Actor', 'active')`,
        [actor.userId, actor.subject, actor.email],
      );
      for (const role of actor.platformRoles)
        await client.query(
          `INSERT INTO identity.platform_role_assignment (user_id, role_key, granted_by) VALUES ($1, $2, 'test')`,
          [actor.userId, role],
        );
    }
    await client.query(
      `INSERT INTO identity.user_account (id, idp_subject, email, display_name, status) VALUES ($1, $2, $3, 'Issuer User', 'active')`,
      [ids.issuerUser, `idp-${ids.issuerUser}`, `iu.${suffix}@escalation.test`],
    );
    await client.query(
      `INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by) VALUES ($1, $2, 'reporting-user', 'test'), ($3, $2, 'issuer-administrator', 'test')`,
      [ids.issuerUser, TENANT, ids.issuerAdmin],
    );
  });

  const idp = {
    ensureUser: async () => randomUUID(),
    sendInvitation: async () => true,
    setEnabled: async (subject: string, enabled: boolean) =>
      void idpCalls.push(`setEnabled:${subject}:${enabled}`),
    requireSecondFactor: async (subject: string) => (
      idpCalls.push(`requireSecondFactor:${subject}`),
      true
    ),
    endSessions: async (subject: string) => void idpCalls.push(`endSessions:${subject}`),
    loginErrors: async () => [],
  };
  // identity-service asks issuer-service whether the issuer accepts users.
  const fakeIssuerFetch: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        data: {
          id: TENANT,
          slug: 'escalation-test',
          displayName: 'Escalation Test',
          internalReference: null,
          status: 'active',
          isSynthetic: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        meta: { correlationId: 'escalation-test-0001', apiVersion: 'v1' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  service = await createService(
    createIdentityService({ identityProvider: idp }),
    {
      ATLAS_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: '0',
      DATABASE_URL: db.roleUrl('identity-service'),
      RABBITMQ_URL: infrastructure.rabbitmqUrl,
      OIDC_ISSUER_URL: TEST_ISSUER,
      SERVICE_CLIENT_SECRET: 'test-client-secret-0123456789',
      IDP_EVENT_POLL_INTERVAL_MS: '0',
    },
    {
      overrides: {
        keySet: tokens.keySet,
        principals: staticPrincipals(actors),
        tokens: tokens.tokenProvider('identity-service'),
        fetch: fakeIssuerFetch,
      },
    },
  );
}, 120_000);

afterAll(async () => {
  await service?.stop();
  await db?.drop();
});

async function call(actor: string, method: string, url: string, payload?: unknown) {
  const response = await service.app.inject({
    method: method as 'GET',
    url,
    headers: {
      authorization: `Bearer ${await tokens.serviceToken('api-gateway', 'identity-service')}`,
      'x-atlas-user-token': await tokens.userToken(actor, { amr: ['pwd', 'otp'] }),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { payload: payload as object } : {}),
  });
  return {
    status: response.statusCode,
    body: response.json() as { code?: string; detail?: string; data?: unknown },
  };
}

describe('privilege ceiling for platform administration', () => {
  it('stops a narrow user manager from creating a Platform Super Admin', async () => {
    const result = await call(ids.userManager, 'POST', '/v1/identity/platform-users', {
      email: `alt.${suffix}@escalation.test`,
      displayName: 'Second account',
      roles: ['platform-super-admin'],
    });
    expect(result.status).toBe(403);
    expect(result.body.detail).toMatch(/permissions you do not hold/);
  });

  it('stops a narrow user manager from demoting or disabling someone more privileged', async () => {
    expect(
      (
        await call(ids.userManager, 'PUT', `/v1/identity/platform-users/${ids.superAdmin}/roles`, {
          roles: [],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ids.userManager, 'POST', `/v1/identity/users/${ids.superAdmin}/status`, {
          status: 'disabled',
          reason: 'escalation test',
        })
      ).status,
    ).toBe(403);
  });

  it('stops a role manager from defining or widening roles beyond their own permissions', async () => {
    const created = await call(ids.roleManager, 'POST', '/v1/identity/roles', {
      key: `wide-${suffix}`,
      scope: 'platform',
      name: 'Too wide',
      description: '',
      permissions: ['issuer.create', 'platform.users.manage'],
    });
    expect(created.status).toBe(403);
  });

  it('stops anyone changing a role they hold', async () => {
    const changed = await call(
      ids.roleManager,
      'PUT',
      `/v1/identity/roles/role-manager-${suffix}`,
      {
        name: 'Role manager',
        description: 'now with more',
        permissions: ['platform.roles.manage'],
      },
    );
    expect(changed.status).toBe(409);
  });

  it('still lets a Platform Super Admin do all of the above to others', async () => {
    const created = await call(ids.superAdmin, 'POST', '/v1/identity/roles', {
      key: `ops-${suffix}`,
      scope: 'tenant',
      name: 'Ops',
      description: '',
      permissions: ['issuer.read', 'reports.read'],
    });
    expect(created.status).toBe(201);
  });
});

describe('no self-change through any endpoint', () => {
  it('refuses an invitation of oneself (platform and issuer)', async () => {
    const platform = await call(ids.userManager, 'POST', '/v1/identity/platform-users', {
      email: actors[ids.userManager]!.email,
      displayName: 'Me',
      roles: [`user-manager-${suffix}`],
    });
    expect(platform.status).toBe(409);
    const issuer = await call(ids.issuerAdmin, 'POST', `/v1/tenants/${TENANT}/users`, {
      email: actors[ids.issuerAdmin]!.email,
      displayName: 'Me',
      roles: ['fraud-manager'],
    });
    expect(issuer.status).toBe(409);
    const roles = await withClient(db.migratorUrl, (client) =>
      client.query('SELECT role_key FROM identity.tenant_role_assignment WHERE user_id = $1', [
        ids.issuerAdmin,
      ]),
    );
    expect(roles.rows.map((r) => r.role_key)).toEqual(['issuer-administrator']);
  });
});

describe('second factor on promotion to platform roles', () => {
  it('requires TOTP enrolment and ends sessions when an issuer user is given a platform role', async () => {
    idpCalls.length = 0;
    const promoted = await call(
      ids.superAdmin,
      'PUT',
      `/v1/identity/platform-users/${ids.issuerUser}/roles`,
      {
        roles: ['technical-administrator'],
      },
    );
    expect(promoted.status).toBe(200);
    expect(idpCalls).toEqual([
      `requireSecondFactor:idp-${ids.issuerUser}`,
      `endSessions:idp-${ids.issuerUser}`,
    ]);
    const audited = await withClient(db.migratorUrl, (client) =>
      client.query(
        "SELECT 1 FROM identity.outbox WHERE envelope->'data'->>'action' = 'user.platform-roles.changed' AND envelope->'data'->'metadata'->>'secondFactorRequired' = 'true' AND envelope->'data'->'resource'->>'id' = $1",
        [ids.issuerUser],
      ),
    );
    expect(audited.rowCount).toBe(1);
  });
});
