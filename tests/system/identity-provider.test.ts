import { describe, expect, it } from 'vitest';
import { KEYCLOAK, PortalUser } from './client.js';

/**
 * Identity-provider configuration ATLAS depends on. If the second factor disappeared from `amr`,
 * platform administrators would silently lose platform permissions (ADR-030) — at sign-in under
 * load, or after the first token refresh. So it is tested directly: sign in with password and
 * one-time code as the gateway client, then refresh as the gateway does.
 */
const tokenUrl = `${KEYCLOAK}/realms/atlas/protocol/openid-connect/token`;
const amrOf = (token: string) =>
  (
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as {
      amr?: string[];
    }
  ).amr;

async function token(params: Record<string, string>) {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'atlas-gateway',
      client_secret: process.env.KEYCLOAK_CLIENT_SECRET_GATEWAY!,
      ...params,
    }),
  });
  return (await response.json()) as { access_token: string; refresh_token: string };
}

describe('identity provider', () => {
  it('keeps the second factor in amr for the whole session, including refreshed tokens', async () => {
    const { code, verifier, redirectUri } = await new PortalUser().authorizationCode(
      'super.admin@atlas.test',
      { otp: true },
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000)); // a slow exchange must not lose otp
    const first = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(amrOf(first.access_token)).toEqual(['pwd', 'otp']);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    });
    expect(amrOf(refreshed.access_token)).toEqual(['pwd', 'otp']);
  });

  it('reports only the password for an issuer user without a second factor', async () => {
    const { code, verifier, redirectUri } = await new PortalUser().authorizationCode(
      'admin@northstar.test',
    );
    const first = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(amrOf(first.access_token)).toEqual(['pwd']);
  });
});
