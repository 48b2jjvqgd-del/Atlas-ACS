import * as client from 'openid-client';

/**
 * OpenID Connect relying party for portal sign-in (authorisation code flow with PKCE).
 *
 * The provider is reached through two base URLs that name the same issuer:
 *   public    what browsers use and what tokens carry as "iss" (OIDC_ISSUER_URL)
 *   internal  what the gateway uses for back-channel calls (OIDC_INTERNAL_URL, e.g. inside Docker)
 * Endpoint metadata is therefore set explicitly — browser-facing endpoints on the public URL,
 * token and key endpoints on the internal URL — instead of relying on discovery, which would
 * reject the differing hostnames. The paths are standard for Keycloak; another provider is
 * configured by changing these paths (or by enabling discovery) without other code changes.
 */
export interface OidcSettings {
  publicIssuer: string;
  internalIssuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  /** Permit plain-HTTP provider URLs (local development only). */
  allowHttp: boolean;
}

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
  subject: string;
  amr: string[];
  idpSessionId: string | null;
}

export interface OidcClient {
  /** Builds the provider URL to redirect the browser to, with the values to keep server-side. */
  startSignIn(): Promise<{ url: string; state: string; nonce: string; codeVerifier: string }>;
  completeSignIn(
    callbackQuery: string,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<OidcTokens>;
  refresh(
    refreshToken: string,
  ): Promise<Omit<OidcTokens, 'amr' | 'subject' | 'idpSessionId'> & { idToken: string | null }>;
  /** Revokes a refresh token at the provider (back-channel), ending that client session there. */
  revoke(refreshToken: string): Promise<void>;
  endSessionUrl(idToken: string | null): string;
  /** Account console where users manage their password and second factor. */
  accountUrl: string;
}

export function createOidcClient(settings: OidcSettings): OidcClient {
  const pub = settings.publicIssuer.replace(/\/$/, '');
  const internal = settings.internalIssuer.replace(/\/$/, '');
  const config = new client.Configuration(
    {
      issuer: pub,
      authorization_endpoint: `${pub}/protocol/openid-connect/auth`,
      end_session_endpoint: `${pub}/protocol/openid-connect/logout`,
      token_endpoint: `${internal}/protocol/openid-connect/token`,
      jwks_uri: `${internal}/protocol/openid-connect/certs`,
      revocation_endpoint: `${internal}/protocol/openid-connect/revoke`,
      code_challenge_methods_supported: ['S256'],
    },
    settings.clientId,
    settings.clientSecret,
  );
  if (settings.allowHttp) client.allowInsecureRequests(config);

  const claimsOf = (token: string): Record<string, unknown> => {
    const payload = token.split('.')[1];
    if (!payload) return {};
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  };

  return {
    accountUrl: `${pub}/account`,
    async startSignIn() {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: settings.redirectUri,
        scope: 'openid profile email',
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url: url.href, state, nonce, codeVerifier };
    },
    async completeSignIn(callbackQuery, expected) {
      const current = new URL(settings.redirectUri);
      current.search = callbackQuery;
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: expected.codeVerifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims?.sub) throw new Error('ID token missing subject');
      // amr is authoritative from the ID token (validated by openid-client against the nonce).
      const amr = Array.isArray(idClaims.amr)
        ? idClaims.amr.filter((v): v is string => typeof v === 'string')
        : [];
      const access = claimsOf(tokens.access_token);
      if (access.sub !== idClaims.sub)
        throw new Error('Access token subject does not match ID token');
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        expiresAt: Date.now() + (tokens.expires_in ?? 60) * 1000,
        subject: idClaims.sub,
        amr,
        idpSessionId: typeof idClaims.sid === 'string' ? idClaims.sid : null,
      };
    },
    async refresh(refreshToken) {
      const tokens = await client.refreshTokenGrant(config, refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? refreshToken,
        idToken: tokens.id_token ?? null,
        expiresAt: Date.now() + (tokens.expires_in ?? 60) * 1000,
      };
    },
    async revoke(refreshToken) {
      await client.tokenRevocation(config, refreshToken, { token_type_hint: 'refresh_token' });
    },
    endSessionUrl(idToken) {
      return client.buildEndSessionUrl(config, {
        post_logout_redirect_uri: settings.postLogoutRedirectUri,
        client_id: settings.clientId,
        ...(idToken ? { id_token_hint: idToken } : {}),
      }).href;
    },
  };
}
