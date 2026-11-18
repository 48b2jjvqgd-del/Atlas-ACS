import { isServiceName, type ServiceName } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Bearer-token verification (Stage 1A).
 *
 * Two token kinds reach a service, both issued by the OIDC provider (Keycloak locally) and both
 * verified locally against the provider's published signing keys (JWKS) — no per-request call to
 * the provider:
 *
 *   service token   OAuth 2.0 client-credentials token of the *calling service*.
 *                   aud = atlas-<callee>   azp = atlas-svc-<caller>
 *   user token      access token of the signed-in portal user, forwarded by the gateway.
 *                   aud includes atlas-api   azp = atlas-gateway
 *
 * Signature, issuer, audience, expiry (with a small clock tolerance) and the authorised party are
 * all checked. Keys are cached and refreshed when an unknown key id appears, so key rotation at the
 * provider needs no restart.
 */
export const USER_TOKEN_AUDIENCE = 'atlas-api';
export const PORTAL_CLIENT_ID = 'atlas-gateway';
const SERVICE_CLIENT_PREFIX = 'atlas-svc-';
const ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const CLOCK_TOLERANCE_SECONDS = 5;

export function serviceAudience(service: ServiceName): string {
  return `atlas-${service}`;
}

export function serviceClientId(service: ServiceName): string {
  return `${SERVICE_CLIENT_PREFIX}${service}`;
}

export interface VerifiedServiceToken {
  caller: ServiceName;
  expiresAt: Date;
}

export interface VerifiedUserToken {
  subject: string;
  /** IdP session id (sid), when present. */
  sessionId: string | undefined;
  email: string | undefined;
  name: string | undefined;
  /** Authentication methods used for this sign-in, e.g. ["pwd", "otp"]. */
  amr: string[];
  expiresAt: Date;
  /** The raw token, for forwarding to another service on the user's behalf. Never log it. */
  raw: string;
}

export interface TokenVerifierOptions {
  /** Expected "iss" claim (the provider's public issuer URL). */
  issuer: string;
  /** Where to fetch signing keys. Defaults to the provider's standard Keycloak JWKS path. */
  jwksUrl?: string;
  /** Inject a key set directly (tests). */
  keySet?: JWTVerifyGetKey;
}

export interface TokenVerifier {
  verifyServiceToken(token: string, audience: ServiceName): Promise<VerifiedServiceToken>;
  verifyUserToken(token: string): Promise<VerifiedUserToken>;
}

export function defaultJwksUrl(issuerOrInternalBase: string): string {
  return `${issuerOrInternalBase.replace(/\/$/, '')}/protocol/openid-connect/certs`;
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const keySet =
    options.keySet ??
    createRemoteJWKSet(new URL(options.jwksUrl ?? defaultJwksUrl(options.issuer)), {
      timeoutDuration: 3_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });

  async function verify(token: string, audience: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: options.issuer,
        audience,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      if (payload.typ !== undefined && payload.typ !== 'Bearer') throw new InvalidTokenError('typ');
      return payload;
    } catch (error) {
      if (error instanceof AtlasError) throw error;
      // Failing to obtain signing keys is an availability problem, not a bad token: fail closed
      // with 503 so callers do not mistake an outage for an authentication failure.
      if (
        error instanceof joseErrors.JWKSTimeout ||
        !(error instanceof joseErrors.JOSEError || error instanceof InvalidTokenError)
      ) {
        throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
          detail: 'Token signing keys are unavailable',
          cause: error,
        });
      }
      throw new AtlasError('UNAUTHENTICATED', { detail: tokenFailureDetail(error), cause: error });
    }
  }

  return {
    async verifyServiceToken(token, audience) {
      const payload = await verify(token, serviceAudience(audience));
      const azp = typeof payload.azp === 'string' ? payload.azp : '';
      const caller = azp.startsWith(SERVICE_CLIENT_PREFIX)
        ? azp.slice(SERVICE_CLIENT_PREFIX.length)
        : '';
      if (!isServiceName(caller)) {
        throw new AtlasError('UNAUTHENTICATED', { detail: 'Token is not a service token' });
      }
      return { caller, expiresAt: new Date((payload.exp ?? 0) * 1000) };
    },
    async verifyUserToken(token) {
      const payload = await verify(token, USER_TOKEN_AUDIENCE);
      if (payload.azp !== PORTAL_CLIENT_ID) {
        throw new AtlasError('UNAUTHENTICATED', { detail: 'Token was not issued to the portal' });
      }
      return {
        subject: payload.sub as string,
        sessionId: typeof payload.sid === 'string' ? payload.sid : undefined,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        name: typeof payload.name === 'string' ? payload.name : undefined,
        amr: Array.isArray(payload.amr)
          ? payload.amr.filter((v): v is string => typeof v === 'string')
          : [],
        expiresAt: new Date((payload.exp ?? 0) * 1000),
        raw: token,
      };
    },
  };
}

class InvalidTokenError extends Error {}

/** A short, client-safe reason. Never includes the token or claim values. */
function tokenFailureDetail(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return 'Token has expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return error.claim === 'aud' ? 'Token audience is not accepted' : 'Token claims are invalid';
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed)
    return 'Token signature is invalid';
  if (error instanceof joseErrors.JWKSNoMatchingKey) return 'Token signing key is not recognised';
  return 'Token is invalid';
}

/** Extracts a bearer token from an Authorization header value. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)$/i.exec(value.trim());
  return match?.[1];
}
