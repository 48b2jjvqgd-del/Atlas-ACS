import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A scripted portal user: performs the real OpenID Connect sign-in through the portal origin
 * (gateway → Keycloak login form → optional one-time code → callback), keeps cookies like a
 * browser, and calls the API with the session's CSRF token.
 */
const envFile = join(import.meta.dirname, '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const PORTAL = process.env.SYSTEM_TEST_PORTAL_URL ?? 'http://localhost:8080';
export const KEYCLOAK = process.env.SYSTEM_TEST_KEYCLOAK_URL ?? 'http://localhost:8180';
export const DEMO_PASSWORD = required('ATLAS_DEMO_PASSWORD');
const TOTP_SECRET = required('ATLAS_DEMO_TOTP_SECRET');

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set: run pnpm setup:env and start the stack (pnpm stack:up)`);
  return value;
}

export function totp(time = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = createHmac('sha1', Buffer.from(TOTP_SECRET, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const NORTHSTAR = '1a2b0000-0000-4000-8000-000000000001';
export const MERIDIAN = '1a2b0000-0000-4000-8000-000000000002';
export const HARBOURLINE = '1a2b0000-0000-4000-8000-000000000003';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: bodies are asserted per test
export interface ApiResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class PortalUser {
  readonly cookies = new Map<string, string>();
  csrf: string | undefined;

  private cookieHeader(url: string): string {
    const host = new URL(url).host;
    return [...this.cookies]
      .filter(([key]) => key.startsWith(`${host}|`))
      .map(([key, value]) => `${key.split('|')[1]}=${value}`)
      .join('; ');
  }

  private store(url: string, response: Response) {
    const host = new URL(url).host;
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const index = pair!.indexOf('=');
      const name = pair!.slice(0, index).trim();
      const value = pair!.slice(index + 1).trim();
      if (/max-age=0/i.test(header) || value === '') this.cookies.delete(`${host}|${name}`);
      else this.cookies.set(`${host}|${name}`, value);
    }
  }

  async raw(url: string, init: RequestInit = {}): Promise<Response> {
    const absolute = url.startsWith('http') ? url : `${PORTAL}${url}`;
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader(absolute);
    if (cookie) headers.set('cookie', cookie);
    const response = await fetch(absolute, { ...init, headers, redirect: 'manual' });
    this.store(absolute, response);
    return response;
  }

  /** Signs in. Returns where the portal sends the browser afterwards. */
  async signIn(email: string, options: { otp?: boolean; password?: string } = {}): Promise<string> {
    const start = await this.raw('/api/v1/auth/login?returnTo=/');
    if (start.status !== 302) throw new Error(`login start returned ${start.status}`);
    let page = await this.raw(start.headers.get('location')!);
    let html = await page.text();
    page = await this.submit(html, {
      username: email,
      password: options.password ?? DEMO_PASSWORD,
    });
    if (options.otp) {
      html = await page.text();
      page = await this.submit(html, { otp: await freshCode(email) });
    }
    if (page.status !== 302) throw new SignInRefused(await page.text());
    const callback = await this.raw(page.headers.get('location')!);
    const target = callback.headers.get('location') ?? '';
    await this.session();
    return target;
  }

  /**
   * Drives the provider's login pages for the gateway client with this test's own PKCE values and
   * returns the authorisation code instead of delivering it to the gateway (for inspecting tokens).
   */
  async authorizationCode(email: string, options: { otp?: boolean } = {}) {
    const verifier = randomBytes(32).toString('base64url');
    const redirectUri = `${PORTAL}/api/v1/auth/callback`;
    const authorize = new URL(`${KEYCLOAK}/realms/atlas/protocol/openid-connect/auth`);
    authorize.search = new URLSearchParams({
      client_id: 'atlas-gateway',
      response_type: 'code',
      scope: 'openid',
      redirect_uri: redirectUri,
      state: randomBytes(8).toString('hex'),
      nonce: randomBytes(8).toString('hex'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    let page = await this.submit(await (await this.raw(authorize.href)).text(), {
      username: email,
      password: DEMO_PASSWORD,
    });
    if (options.otp) page = await this.submit(await page.text(), { otp: await freshCode(email) });
    const location = page.headers.get('location');
    const code = location ? new URL(location).searchParams.get('code') : null;
    if (!code) throw new SignInRefused(await page.text());
    return { code, verifier, redirectUri };
  }

  private async submit(html: string, fields: Record<string, string>): Promise<Response> {
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (!action) throw new Error('no form on identity-provider page');
    return this.raw(action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  }

  async session(): Promise<ApiResult> {
    const result = await this.api('GET', '/v1/session');
    if (result.status === 200) this.csrf = result.body.data.csrfToken;
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see ApiResult
  async api<T = any>(
    method: string,
    path: string,
    body?: unknown,
    options: { csrf?: boolean } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && (options.csrf ?? true) && this.csrf)
      headers['x-atlas-csrf'] = this.csrf;
    const response = await this.raw(`/api${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
    };
  }
}

export class SignInRefused extends Error {
  constructor(readonly page: string) {
    super('identity provider did not accept the sign-in');
  }
}

/**
 * One-time codes are single-use at the identity provider (replay protection). The used-code record
 * is per account credential, so only a second sign-in by the same account within one 30-second
 * window waits for the next code. Other accounts sign in at once, even though the synthetic
 * accounts share a secret.
 */
function lastCodeFile(email: string): string {
  const key = createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16);
  return join(tmpdir(), `atlas-system-tests-last-totp-${key}`);
}
async function freshCode(email: string): Promise<string> {
  const file = lastCodeFile(email);
  for (;;) {
    const code = totp();
    // Shared across test files (each runs in its own worker).
    const last = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (code !== last) {
      writeFileSync(file, code);
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const sessions = new Map<string, PortalUser>();

/**
 * A signed-in seeded synthetic account; platform accounts use their pre-enrolled second factor.
 * Sessions are reused across tests (sign-in is rate limited per address, as in production);
 * pass fresh for a session the test may end.
 */
export async function signedIn(
  email: string,
  options: { fresh?: boolean } = {},
): Promise<PortalUser> {
  const cached = sessions.get(email);
  if (cached && !options.fresh && (await cached.session()).status === 200) return cached;
  const user = new PortalUser();
  await user.signIn(email, { otp: email.endsWith('@atlas.test') });
  if (!options.fresh) sessions.set(email, user);
  return user;
}

export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
