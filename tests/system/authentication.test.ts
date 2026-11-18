import { describe, expect, it } from 'vitest';
import { PortalUser, SignInRefused, signedIn } from './client.js';

describe('authentication (OIDC through the gateway)', () => {
  it('signs a platform administrator in with password and one-time code, without exposing tokens', async () => {
    const user = new PortalUser();
    const target = await user.signIn('super.admin@atlas.test', { otp: true });
    expect(target).toMatch(/\/$/);
    const session = await user.session();
    expect(session.status).toBe(200);
    expect(session.body.data.mfa).toBe(true);
    expect(session.body.data.principal.platformRoles).toEqual(['platform-super-admin']);
    expect(JSON.stringify(session.body)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWTs reach the browser
    const cookies = [...user.cookies.keys()].map((key) => key.split('|')[1]);
    expect(cookies).toContain('__Host-atlas_session');
    expect(session.headers.get('cache-control')).toBe('no-store');
  });

  it('signs an issuer user in with password only, as an issuer-scoped principal', async () => {
    const user = await signedIn('support@northstar.test');
    const { body } = await user.session();
    expect(body.data.mfa).toBe(false);
    expect(body.data.principal.platformPermissions).toEqual([]);
    expect(body.data.principal.tenants[0].roles).toEqual(['customer-support']);
  });

  it('rejects a wrong password at the identity provider and creates no session', async () => {
    const user = new PortalUser();
    await expect(
      user.signIn('admin@northstar.test', { password: 'not-the-password-123' }),
    ).rejects.toBeInstanceOf(SignInRefused);
    expect((await user.session()).status).toBe(401);
  });

  it('refuses unauthenticated and tampered-session API calls', async () => {
    const anonymous = new PortalUser();
    expect((await anonymous.api('GET', '/v1/tenants')).status).toBe(401);
    expect((await anonymous.api('GET', '/v1/identity/me')).status).toBe(401);
    anonymous.cookies.set(
      `${new URL('http://localhost:8080').host}|__Host-atlas_session`,
      'forged-session-id-value',
    );
    const forged = await anonymous.api('GET', '/v1/session');
    expect(forged.status).toBe(401);
  });

  it('signs out: the session ends, and replaying the old cookie no longer works', async () => {
    const user = await signedIn('reporting@northstar.test', { fresh: true });
    const saved = new Map(user.cookies);
    const logout = await user.api('POST', '/v1/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.body.data.endSessionUrl).toContain('/protocol/openid-connect/logout');
    expect((await user.session()).status).toBe(401);
    const replay = new PortalUser();
    for (const [key, value] of saved) replay.cookies.set(key, value);
    expect((await replay.session()).status).toBe(401);
  });

  it('requires the CSRF token for state-changing requests', async () => {
    const user = await signedIn('admin@northstar.test', { fresh: true });
    const response = await user.api('POST', '/v1/auth/logout', undefined, { csrf: false });
    expect(response.status).toBe(403);
    expect((await user.session()).status).toBe(200);
  });

  it('rejects open redirects after sign-in', async () => {
    const user = new PortalUser();
    const start = await user.raw('/api/v1/auth/login?returnTo=//evil.example/');
    expect(start.status).toBe(302);
    // The return path is normalised server-side; the provider URL carries no foreign redirect.
    expect(start.headers.get('location')).not.toContain('evil.example');
  });
});
