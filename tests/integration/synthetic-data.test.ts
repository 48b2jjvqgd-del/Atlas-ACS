import { randomBytes, randomUUID } from 'node:crypto';
import { permissionKeys, permissionAllowsScope, type Principal } from '@atlas/contracts';
import { createIdentityService } from '@atlas/identity-service/service';
import { definition as issuerService } from '@atlas/issuer-service/service';
import { createService } from '@atlas/service-kit';
import {
  createTestIssuer,
  principal,
  staticPrincipals,
  TEST_ISSUER,
} from '@atlas/service-kit/testing';
import { atlasEnvironments } from '@atlas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from './database.js';
import { infrastructure } from './env.js';

/**
 * Finding 2: Stage 1A cannot create non-synthetic issuer or user records, whatever ATLAS_ENV says.
 * The real issuer-service and identity-service run against a provisioned database (their own
 * least-privilege roles) in every recognised environment and create records through their APIs.
 */
let db: TestDatabase;
let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
const ADMIN = randomUUID();
const admin: Principal = principal({
  userId: ADMIN,
  subject: ADMIN,
  displayName: 'Synthetic Platform Admin',
  platformRoles: ['platform-super-admin'],
  platformPermissions: permissionKeys.filter((p) => permissionAllowsScope(p, 'platform')),
});

beforeAll(async () => {
  db = await createTestDatabase('synthetic');
  issuer = await createTestIssuer();
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

const baseEnv = (environment: string, service: string) => ({
  ATLAS_ENV: environment,
  LOG_LEVEL: 'silent',
  PORT: '0',
  DATABASE_URL: db.roleUrl(service),
  RABBITMQ_URL: infrastructure.rabbitmqUrl,
  OIDC_ISSUER_URL: TEST_ISSUER,
  SERVICE_CLIENT_SECRET: 'test-client-secret-0123456789',
  IDP_ADMIN_ENABLED: 'false',
});

async function headersFor(audience: 'issuer-service' | 'identity-service') {
  return {
    authorization: `Bearer ${await issuer.serviceToken('api-gateway', audience)}`,
    'x-atlas-user-token': await issuer.userToken(ADMIN, { amr: ['pwd', 'otp'] }),
    'content-type': 'application/json',
  };
}

describe('synthetic-only records in every environment (Finding 2)', () => {
  for (const environment of atlasEnvironments) {
    it(`creates only synthetic issuers and users with ATLAS_ENV=${environment}`, async () => {
      const suffix = randomBytes(3).toString('hex');
      const overrides = {
        keySet: issuer.keySet,
        principals: staticPrincipals({ [ADMIN]: admin }),
      };
      const issuers = await createService(issuerService, baseEnv(environment, 'issuer-service'), {
        overrides: { ...overrides, tokens: issuer.tokenProvider('issuer-service') },
      });
      const identity = await createService(
        createIdentityService({ identityProvider: null }),
        baseEnv(environment, 'identity-service'),
        { overrides: { ...overrides, tokens: issuer.tokenProvider('identity-service') } },
      );
      try {
        const created = await issuers.app.inject({
          method: 'POST',
          url: '/v1/tenants',
          headers: await headersFor('issuer-service'),
          payload: {
            slug: `env-${environment}-${suffix}`,
            displayName: `Synthetic ${environment} issuer`,
            internalReference: `ENV-${suffix.toUpperCase()}`,
          },
        });
        expect(created.statusCode, created.body).toBe(201);
        expect(created.json().data.isSynthetic).toBe(true);

        const invited = await identity.app.inject({
          method: 'POST',
          url: '/v1/identity/platform-users',
          headers: await headersFor('identity-service'),
          payload: {
            email: `user.${environment}.${suffix}@synthetic.test`,
            displayName: 'Synthetic User',
            roles: ['technical-administrator'],
          },
        });
        expect(invited.statusCode, invited.body).toBe(201);
        expect(invited.json().data.isSynthetic).toBe(true);

        // Real-looking contact details are refused at the API as well as in the database.
        const realEmail = await identity.app.inject({
          method: 'POST',
          url: '/v1/identity/platform-users',
          headers: await headersFor('identity-service'),
          payload: {
            email: `someone.${suffix}@gmail.com`,
            displayName: 'Real?',
            roles: ['technical-administrator'],
          },
        });
        expect(realEmail.statusCode).toBe(400);
        const realContact = await issuers.app.inject({
          method: 'POST',
          url: '/v1/tenants',
          headers: await headersFor('issuer-service'),
          payload: {
            slug: `contact-${environment}-${suffix}`,
            displayName: 'Contact check',
            internalReference: `CC-${suffix.toUpperCase()}`,
            settings: { supportContactEmail: 'cards@real-bank.co.uk' },
          },
        });
        expect(realContact.statusCode).toBe(400);
      } finally {
        await Promise.all([issuers.stop(), identity.stop()]);
      }
    }, 60_000);
  }

  it('leaves no non-synthetic record in the database', async () => {
    const counts = await withClient(db.migratorUrl, async (client) => ({
      issuers: (await client.query('SELECT 1 FROM issuer.tenant WHERE NOT is_synthetic')).rowCount,
      users: (await client.query('SELECT 1 FROM identity.user_account WHERE NOT is_synthetic'))
        .rowCount,
    }));
    expect(counts).toEqual({ issuers: 0, users: 0 });
  });
});
