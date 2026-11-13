import type { ServiceName } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { serviceClientId } from './tokens.js';

/**
 * Obtains OAuth 2.0 client-credentials tokens for calls to other services.
 *
 * - One token per callee: each is requested with the scope `aud-<callee>`, so the provider issues a
 *   token whose only audience is that callee. The provider refuses audiences the caller has not
 *   been granted, so the service-to-service call graph is enforced by the provider as well as by
 *   each callee's route policy.
 * - Tokens are cached until shortly before expiry; concurrent requests share one fetch.
 * - The client secret comes from configuration (`SERVICE_CLIENT_SECRET` or `_FILE`) and is never
 *   logged. Rotation: the provider accepts the new secret, the secret file is replaced, and the
 *   service picks it up on its next token request after restart (rotation without restart is a
 *   Stage 7 secrets-management item).
 */
export interface ServiceTokenProvider {
  token(audience: ServiceName): Promise<string>;
  /** Drops a cached token (e.g. after the callee rejected it); the next call fetches a new one. */
  invalidate?(audience: ServiceName): void;
}

export interface ClientCredentialsOptions {
  service: ServiceName;
  /** Token endpoint, e.g. http://keycloak:8080/realms/atlas/protocol/openid-connect/token */
  tokenUrl: string;
  clientSecret: string;
  timeoutMs?: number;
  /** Refresh this long before expiry. */
  refreshMarginMs?: number;
  fetch?: typeof fetch;
}

export function defaultTokenUrl(issuerOrInternalBase: string): string {
  return `${issuerOrInternalBase.replace(/\/$/, '')}/protocol/openid-connect/token`;
}

export function createClientCredentialsProvider(
  options: ClientCredentialsOptions,
): ServiceTokenProvider {
  const doFetch = options.fetch ?? fetch;
  const margin = options.refreshMarginMs ?? 30_000;
  const cache = new Map<ServiceName, { token: string; expiresAt: number }>();
  const inflight = new Map<ServiceName, Promise<string>>();

  async function fetchToken(audience: ServiceName): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(options.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: serviceClientId(options.service),
          client_secret: options.clientSecret,
          scope: `aud-${audience}`,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
      });
    } catch (error) {
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: 'Identity provider unreachable',
        cause: error,
      });
    }
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!response.ok || !body.access_token) {
      // The provider's error code (e.g. invalid_scope, unauthorized_client) is safe to surface.
      throw new AtlasError('DEPENDENCY_UNAVAILABLE', {
        detail: `Service token request refused${body.error ? ` (${body.error})` : ''}`,
      });
    }
    cache.set(audience, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 60) * 1000,
    });
    return body.access_token;
  }

  return {
    invalidate(audience) {
      cache.delete(audience);
    },
    async token(audience) {
      const cached = cache.get(audience);
      if (cached && cached.expiresAt - margin > Date.now()) return cached.token;
      let pending = inflight.get(audience);
      if (!pending) {
        pending = fetchToken(audience).finally(() => inflight.delete(audience));
        inflight.set(audience, pending);
      }
      return pending;
    },
  };
}
