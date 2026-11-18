import type { Principal, ServiceName } from '@atlas/contracts';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import type { PrincipalResolver } from '../auth/access.js';
import type { ServiceTokenProvider } from '../auth/service-tokens.js';
import {
  PORTAL_CLIENT_ID,
  serviceAudience,
  serviceClientId,
  USER_TOKEN_AUDIENCE,
} from '../auth/tokens.js';

/**
 * Test-only token issuer: a local signing key and JWKS standing in for the identity provider, so
 * unit tests exercise real signature, issuer, audience and expiry checks without Keycloak.
 * Not exported from the package root; import from "@atlas/service-kit/testing".
 */
export const TEST_ISSUER = 'https://idp.test/realms/atlas';

export interface TestIssuer {
  issuer: string;
  keySet: JWTVerifyGetKey;
  serviceToken(
    caller: ServiceName,
    audience: ServiceName,
    options?: { expiresIn?: string | number; azp?: string },
  ): Promise<string>;
  userToken(
    subject: string,
    options?: { amr?: string[]; expiresIn?: string | number; azp?: string; audience?: string },
  ): Promise<string>;
  /** Signed by a different key: fails signature verification. */
  forgedToken(subject: string): Promise<string>;
  tokenProvider(caller: ServiceName): ServiceTokenProvider;
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keySet = createLocalJWKSet({ keys: [jwk] });

  const sign = (claims: Record<string, unknown>, expiresIn: string | number, key = privateKey) =>
    new SignJWT({ typ: 'Bearer', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(TEST_ISSUER)
      .setIssuedAt(
        Math.floor(Date.now() / 1000) - (typeof expiresIn === 'number' && expiresIn < 0 ? 120 : 0),
      )
      .setExpirationTime(
        typeof expiresIn === 'number' ? Math.floor(Date.now() / 1000) + expiresIn : expiresIn,
      )
      .sign(key);

  const issuer: TestIssuer = {
    issuer: TEST_ISSUER,
    keySet,
    serviceToken(caller, audience, options = {}) {
      return sign(
        {
          sub: `service-account-${caller}`,
          aud: serviceAudience(audience),
          azp: options.azp ?? serviceClientId(caller),
        },
        options.expiresIn ?? '5m',
      );
    },
    userToken(subject, options = {}) {
      return sign(
        {
          sub: subject,
          aud: options.audience ?? USER_TOKEN_AUDIENCE,
          azp: options.azp ?? PORTAL_CLIENT_ID,
          amr: options.amr ?? ['pwd'],
          email: `${subject}@example.test`,
          sid: 'test-session',
        },
        options.expiresIn ?? '5m',
      );
    },
    forgedToken(subject) {
      return sign(
        { sub: subject, aud: USER_TOKEN_AUDIENCE, azp: PORTAL_CLIENT_ID },
        '5m',
        other.privateKey,
      );
    },
    tokenProvider(caller) {
      return { token: (audience) => issuer.serviceToken(caller, audience) };
    },
  };
  return issuer;
}

/** A principal resolver backed by a fixed map (subject → principal). */
export function staticPrincipals(principals: Record<string, Principal>): PrincipalResolver {
  return { resolve: async (subject) => principals[subject] ?? null };
}

export function principal(overrides: Partial<Principal> & Pick<Principal, 'userId'>): Principal {
  return {
    subject: overrides.userId,
    email: `${overrides.userId}@example.test`,
    displayName: 'Test User',
    status: 'active',
    platformPermissions: [],
    platformRoles: [],
    tenants: [],
    ...overrides,
  };
}
