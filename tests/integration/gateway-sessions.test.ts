import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { definition } from '@atlas/api-gateway/service';
import { csrfHeader, type Principal } from '@atlas/contracts';
import { createService, type RunningService } from '@atlas/service-kit';
import { createTestIssuer, TEST_ISSUER, type TestIssuer } from '@atlas/service-kit/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../../services/api-gateway/src/sessions.js';
import { infrastructure } from './env.js';

/**
 * The real api-gateway against a real Valkey, driven through its sign-in, session and rate-limit
 * code. Only the edges are replaced: the identity provider (a fake OIDC client issuing access tokens
 * signed by a local test issuer, which the gateway verifies for real) and identity-service (a fake
 * fetch answering the two principal endpoints). RabbitMQ is unreachable on purpose, so audit events
 * stay in this test's Valkey database and are never published.
 *
 * Covers: session fixation (final review), malformed cookies with a working session store (F-12),
 * rate-limit identities that client-chosen cookies cannot rotate (L-2), expired sessions still
 * held by Valkey, duplicate session cookies, and CSRF alongside malformed cookies.
 */

// ---------------------------------------------------------------- fake identity provider
const idp = vi.hoisted(() => ({
  /** The sign-in the next callback completes. */
  next: undefined as undefined | { subject: string; accessToken: string },
}));

vi.mock('../../services/api-gateway/src/oidc.js', () => ({
  createOidcClient: () => ({
    accountUrl: 'https://idp.test/account',
    async startSignIn() {
      const state = randomBytes(16).toString('base64url');
      return { url: `https://idp.test/auth?state=${state}`, state, nonce: 'n', codeVerifier: 'v' };
    },
    async completeSignIn() {
      if (!idp.next) throw new Error('no sign-in prepared');
      const { subject, accessToken } = idp.next;
      idp.next = undefined;
      return {
        accessToken,
        refreshToken: null,
        idToken: null,
        expiresAt: Date.now() + 300_000,
        subject,
        amr: ['pwd', 'otp'],
        idpSessionId: `sid-${subject}`,
      };
    },
    async refresh() {
      throw new Error('not used');
    },
    async revoke() {},
    endSessionUrl: () => 'https://idp.test/logout',
  }),
}));

// ---------------------------------------------------------------- fake identity-service
const principals = new Map<string, Principal>();
function principalFor(subject: string): Principal {
  const existing = principals.get(subject);
  if (existing) return existing;
  const principal: Principal = {
    userId: randomUUID(),
    subject,
    email: `${subject}@example.test`,
    displayName: `User ${subject}`,
    status: 'active',
    platformPermissions: [],
    tenants: [],
    platformRoles: [],
  };
  principals.set(subject, principal);
  return principal;
}

const identityService: typeof fetch = async (input) => {
  const path = new URL(typeof input === 'string' ? input : (input as Request).url).pathname;
  const match = /^\/v1\/internal\/principals\/([^/]+)(\/sign-ins)?$/.exec(path);
  if (!match) return new Response('{}', { status: 404 });
  const body = JSON.stringify({
    data: principalFor(decodeURIComponent(match[1]!)),
    meta: { correlationId: 'identity-fake-0001', apiVersion: 'v1' },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
};

// ---------------------------------------------------------------- gateway under test
/** A Valkey database used by nothing else, so this test never touches development data. */
const TEST_DATABASE = 11;
const valkeyUrl = (() => {
  const url = new URL(infrastructure.valkeyUrl);
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
})();
const SESSION = '__Host-atlas_session';
const SESSION_ENCRYPTION_KEY = randomBytes(32).toString('hex');
const LOGIN = '__Host-atlas_login';

let issuer: TestIssuer;
let gateway: RunningService<NonNullable<typeof definition.configShape>>;
let valkey: Redis;

beforeAll(async () => {
  issuer = await createTestIssuer();
  valkey = new Redis(valkeyUrl, { maxRetriesPerRequest: 1 });
  gateway = await createService(
    definition,
    {
      ATLAS_ENV: 'test',
      LOG_LEVEL: 'silent',
      PORT: '0',
      VALKEY_URL: valkeyUrl,
      RABBITMQ_URL: 'amqp://x:x@127.0.0.1:1',
      OIDC_ISSUER_URL: TEST_ISSUER,
      SERVICE_CLIENT_SECRET: 'test-client-secret-0123456789',
      OIDC_CLIENT_SECRET: 'test-gateway-secret-0123456789',
      SESSION_ENCRYPTION_KEY,
      RATE_LIMIT_MAX: '5',
      RATE_LIMIT_SIGN_IN_MAX: '50',
    },
    {
      overrides: {
        keySet: issuer.keySet,
        tokens: issuer.tokenProvider('api-gateway'),
        fetch: identityService,
      },
    },
  );
  await gateway.start();
  // The Valkey connection is opened in the background and commands fail fast until it is ready.
  const client = gateway.context.infrastructure.valkey!.client;
  for (let waited = 0; client.status !== 'ready'; waited += 50) {
    if (waited > 10_000) throw new Error(`gateway Valkey connection not ready: ${client.status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(async () => {
  await gateway?.stop();
  // Remove only what the gateway wrote, and only in this test's own database.
  if (valkey) {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await valkey.scan(cursor, 'MATCH', 'atlas:api-gateway:*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length) await valkey.del(...keys);
    valkey.disconnect();
  }
});

/** A client address of its own, so rate-limit counters from other tests or runs never interfere. */
const newAddress = () =>
  `2001:db8::${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}`;

function cookieFrom(setCookie: string | string[] | undefined, name: string): string | undefined {
  for (const header of [setCookie ?? []].flat()) {
    const [pair] = header.split(';');
    const index = pair!.indexOf('=');
    if (pair!.slice(0, index) === name) return decodeURIComponent(pair!.slice(index + 1));
  }
  return undefined;
}

const storageKey = (id: string) =>
  `atlas:api-gateway:session:${createHash('sha256').update(id).digest('hex')}`;

/**
 * Runs the browser side of a sign-in: /v1/auth/login, then the provider's redirect to
 * /v1/auth/callback. `cookie` is whatever else the browser sends (for example a planted session).
 */
async function signIn(subject: string, options: { cookie?: string; remoteAddress: string }) {
  const extra = options.cookie ? `; ${options.cookie}` : '';
  const login = await gateway.app.inject({
    method: 'GET',
    url: '/v1/auth/login?returnTo=/issuers',
    remoteAddress: options.remoteAddress,
    ...(options.cookie ? { headers: { cookie: options.cookie } } : {}),
  });
  expect(login.statusCode, login.body).toBe(302);
  const state = cookieFrom(login.headers['set-cookie'], LOGIN)!;
  expect(state).toBeTruthy();

  idp.next = { subject, accessToken: await issuer.userToken(subject, { amr: ['pwd', 'otp'] }) };
  const callback = await gateway.app.inject({
    method: 'GET',
    url: `/v1/auth/callback?code=c&state=${encodeURIComponent(state)}`,
    remoteAddress: options.remoteAddress,
    headers: { cookie: `${LOGIN}=${state}${extra}` },
  });
  expect(callback.statusCode, callback.body).toBe(302);
  expect(callback.headers.location).toBe('http://localhost:8080/issuers');
  const id = cookieFrom(callback.headers['set-cookie'], SESSION);
  expect(id, 'the callback issues a session cookie').toBeTruthy();
  return id!;
}

const getSession = (cookie: string, remoteAddress = newAddress()) =>
  gateway.app.inject({ method: 'GET', url: '/v1/session', remoteAddress, headers: { cookie } });

// ---------------------------------------------------------------- tests
describe('session fixation', () => {
  it('never adopts a session id the browser supplies at sign-in, and destroys the supplied session', async () => {
    const remoteAddress = newAddress();
    // The attacker signs in to their own account and plants that live session id in the victim's
    // browser (the strongest form of fixation: the planted id is valid, not just well-formed).
    const planted = await signIn(`attacker-${randomUUID()}`, { remoteAddress });
    expect((await getSession(`${SESSION}=${planted}`)).statusCode).toBe(200);
    expect(await valkey.exists(storageKey(planted))).toBe(1);

    // The victim signs in with the planted cookie present.
    const victimSubject = `victim-${randomUUID()}`;
    const fresh = await signIn(victimSubject, { cookie: `${SESSION}=${planted}`, remoteAddress });

    // A fresh id, of the generated form, unrelated to the planted one.
    expect(fresh).not.toBe(planted);
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The supplied session is destroyed: gone from Valkey, refused by the gateway.
    expect(await valkey.exists(storageKey(planted))).toBe(0);
    const reused = await getSession(`${SESSION}=${planted}`);
    expect(reused.statusCode).toBe(401);
    expect(reused.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    // The original id gives no access to the newly authenticated session...
    expect(JSON.stringify(reused.json())).not.toContain(victimSubject);
    // ...which is reachable only with the fresh id.
    const victim = await getSession(`${SESSION}=${fresh}`);
    expect(victim.statusCode).toBe(200);
    expect(victim.json()).toMatchObject({ data: { principal: { subject: victimSubject } } });
  });

  it('issues a fresh id when the supplied id is well-formed but unknown', async () => {
    const remoteAddress = newAddress();
    const planted = randomBytes(32).toString('base64url');
    const fresh = await signIn(`user-${randomUUID()}`, {
      cookie: `${SESSION}=${planted}`,
      remoteAddress,
    });
    expect(fresh).not.toBe(planted);
    expect(await valkey.exists(storageKey(planted))).toBe(0);
    expect((await getSession(`${SESSION}=${planted}`)).statusCode).toBe(401);
    expect((await getSession(`${SESSION}=${fresh}`)).statusCode).toBe(200);
  });
});

describe('malformed cookies with a working session store (F-12)', () => {
  it('keeps sign-in available and completes it when malformed cookies are present', async () => {
    const remoteAddress = newAddress();
    const id = await signIn(`user-${randomUUID()}`, {
      cookie: `theme=%E0%A4%A; ${SESSION}=%zz; other=%`,
      remoteAddress,
    });
    expect((await getSession(`${SESSION}=${id}`)).statusCode).toBe(200);
  });

  it('honours a valid session cookie next to malformed unrelated cookies', async () => {
    const id = await signIn(`user-${randomUUID()}`, { remoteAddress: newAddress() });
    for (const cookie of [
      `a=%; ${SESSION}=${id}`,
      `${SESSION}=${id}; b=%E0%A4%A`,
      `a=1; theme=%zz; ${SESSION}=${id}; c=hello%20world`,
    ]) {
      expect((await getSession(cookie)).statusCode, cookie).toBe(200);
    }
  });

  it('never authenticates with a malformed session cookie, even next to a valid id', async () => {
    const id = await signIn(`user-${randomUUID()}`, { remoteAddress: newAddress() });
    for (const cookie of [
      `${SESSION}=${id}%`,
      `${SESSION}=${id.slice(0, 20)}%E0%A4%A`,
      `${SESSION}=%; ${SESSION}=${id}`, // the first occurrence wins, even when malformed
      `${SESSION}=${id}x`,
    ]) {
      const response = await getSession(cookie);
      expect(response.statusCode, cookie).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
    // The genuine session is unaffected.
    expect((await getSession(`${SESSION}=${id}`)).statusCode).toBe(200);
  });
});

describe('rate-limit identity (L-2)', () => {
  const unmatched = (cookie: string | undefined, remoteAddress: string) =>
    gateway.app.inject({
      method: 'GET',
      url: '/v1/unknown-route',
      remoteAddress,
      ...(cookie ? { headers: { cookie } } : {}),
    });

  it('does not let rotating arbitrary session cookies escape the per-address limit', async () => {
    const remoteAddress = newAddress();
    const statuses: number[] = [];
    // RATE_LIMIT_MAX is 5. Each request presents a new value: well-formed but unknown ids, short
    // or malformed values, and none at all. All of them share the address's bucket.
    const cookies = [
      () => `${SESSION}=${randomBytes(32).toString('base64url')}`,
      () => `${SESSION}=${randomBytes(8).toString('hex')}`,
      () => `${SESSION}=%${randomBytes(2).toString('hex')}%`,
      () => undefined,
    ];
    for (let attempt = 0; attempt < 8; attempt += 1)
      statuses.push(
        (await unmatched(cookies[attempt % cookies.length]!(), remoteAddress)).statusCode,
      );
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429, 429, 429]);
  });

  it('does not let rotating cookies escape the per-session limit on sensitive writes', async () => {
    const remoteAddress = newAddress();
    const statuses: number[] = [];
    // Sensitive changes allow 20 per minute; every request is unauthenticated (401) until limited.
    for (let attempt = 0; attempt < 22; attempt += 1) {
      const response = await gateway.app.inject({
        method: 'PUT',
        url: `/v1/tenants/${randomUUID()}/configuration`,
        remoteAddress,
        headers: {
          cookie: `${SESSION}=${randomBytes(32).toString('base64url')}`,
          'content-type': 'application/json',
        },
        payload: {},
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it('keeps separate buckets for genuine sessions, keyed without the session id', async () => {
    const remoteAddress = newAddress();
    const first = await signIn(`user-${randomUUID()}`, { remoteAddress: newAddress() });
    const second = await signIn(`user-${randomUUID()}`, { remoteAddress: newAddress() });

    const run = async (cookie: string | undefined, count: number) => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < count; attempt += 1)
        statuses.push((await unmatched(cookie, remoteAddress)).statusCode);
      return statuses;
    };
    // The first session exhausts its own bucket...
    expect(await run(`${SESSION}=${first}`, 6)).toEqual([404, 404, 404, 404, 404, 429]);
    // ...without affecting a second session or anonymous traffic from the same address.
    expect(await run(`${SESSION}=${second}`, 1)).toEqual([404]);
    expect(await run(undefined, 1)).toEqual([404]);

    // Once a session ends, its id no longer earns a bucket of its own.
    await valkey.del(storageKey(second));
    expect(await run(`${SESSION}=${second}`, 5)).toEqual([404, 404, 404, 404, 429]);

    // No rate-limit key contains a session id or a prefix of one.
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await valkey.scan(cursor, 'MATCH', '*ratelimit*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    expect(keys.length).toBeGreaterThan(0);
    for (const id of [first, second]) {
      for (const key of keys) {
        expect(key).not.toContain(id.slice(0, 16));
        expect(key).not.toContain(createHash('sha256').update(id).digest('hex'));
      }
    }
  });
});

describe('expired sessions still held by Valkey', () => {
  it('neither authenticates nor earns a rate-limit bucket, and is destroyed on use', async () => {
    // Plant a session that expires in 200 ms but that Valkey keeps for a minute (as if eviction
    // lagged), written with the gateway's own store and key.
    const store = new SessionStore(
      gateway.context.infrastructure.valkey!.client as unknown as Redis,
      SESSION_ENCRYPTION_KEY,
      { idleMs: 200, absoluteMs: 3_600_000 },
    );
    const id = SessionStore.newId();
    const subject = `expired-${randomUUID()}`;
    await store.save(
      id,
      store.create({
        subject,
        userId: principalFor(subject).userId,
        displayName: 'Expired User',
        idpSessionId: null,
        accessToken: await issuer.userToken(subject, { amr: ['pwd', 'otp'] }),
        accessExpiresAt: Date.now() + 300_000,
        refreshToken: null,
        idToken: null,
        amr: ['pwd', 'otp'],
      }),
    );
    expect(await valkey.pexpire(storageKey(id), 60_000)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await valkey.exists(storageKey(id))).toBe(1);

    // Rate limiting: the expired id shares the address's bucket with anonymous traffic.
    const remoteAddress = newAddress();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await gateway.app.inject({
        method: 'GET',
        url: '/v1/unknown-route',
        remoteAddress,
        ...(attempt % 2 ? { headers: { cookie: `${SESSION}=${id}` } } : {}),
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
    expect(await valkey.exists(storageKey(id)), 'rate limiting has no side effects').toBe(1);

    // Authentication: refused, the cookie is cleared and the stale record is destroyed.
    const response = await getSession(`${SESSION}=${id}`);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(JSON.stringify(response.json())).not.toContain(subject);
    expect(String(response.headers['set-cookie'])).toMatch(/^__Host-atlas_session=; .*Max-Age=0/);
    expect(await valkey.exists(storageKey(id))).toBe(0);
  });
});

describe('duplicate session cookies', () => {
  it('uses a valid first session cookie and ignores a malformed duplicate after it', async () => {
    const subject = `user-${randomUUID()}`;
    const id = await signIn(subject, { remoteAddress: newAddress() });
    for (const cookie of [
      `${SESSION}=${id}; ${SESSION}=%`,
      `${SESSION}=${id}; ${SESSION}=%E0%A4%A`,
      `${SESSION}=${id}; theme=%zz; ${SESSION}=not-a-session-id`,
      `${SESSION}=${id}; ${SESSION}=${SessionStore.newId()}`,
    ]) {
      const response = await getSession(cookie);
      expect(response.statusCode, cookie).toBe(200);
      expect(response.json()).toMatchObject({ data: { principal: { subject } } });
      expect(String(response.headers['set-cookie'] ?? ''), cookie).not.toMatch(/atlas_session=;/);
    }
  });
});

describe('CSRF protection with malformed unrelated cookies', () => {
  const noise = 'theme=%; a=%E0%A4%A; b=%zz';

  it('still refuses state-changing requests without the session token or from a foreign origin', async () => {
    const id = await signIn(`user-${randomUUID()}`, { remoteAddress: newAddress() });
    const cookie = `${noise}; ${SESSION}=${id}; c=%C0%AF`;
    const session = await getSession(cookie);
    expect(session.statusCode).toBe(200);
    const csrfToken = (session.json() as { data: { csrfToken: string } }).data.csrfToken;
    expect(csrfToken).toBeTruthy();

    const write = (extra: Record<string, string>) =>
      gateway.app.inject({
        method: 'PUT',
        url: `/v1/tenants/${randomUUID()}/configuration`,
        remoteAddress: newAddress(),
        headers: { cookie, 'content-type': 'application/json', ...extra },
        payload: {},
      });
    for (const [label, extra] of [
      ['no token', {}],
      ['wrong token', { [csrfHeader]: SessionStore.newCsrfToken() }],
      ['malformed token', { [csrfHeader]: '%' }],
      ['foreign origin', { [csrfHeader]: csrfToken, origin: 'https://attacker.example' }],
    ] as const) {
      const response = await write(extra);
      expect(response.statusCode, label).toBe(403);
      expect(response.json(), label).toMatchObject({ code: 'FORBIDDEN' });
    }

    // Forged sign-out is refused too, and leaves the session intact...
    const forged = await gateway.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      remoteAddress: newAddress(),
      headers: { cookie },
    });
    expect(forged.statusCode).toBe(403);
    expect((await getSession(cookie)).statusCode).toBe(200);

    // ...while the genuine request, with the same malformed cookies, passes the check.
    const genuine = await gateway.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      remoteAddress: newAddress(),
      headers: { cookie, [csrfHeader]: csrfToken, origin: 'http://localhost:8080' },
    });
    expect(genuine.statusCode).toBe(200);
    expect(await valkey.exists(storageKey(id))).toBe(0);
    expect((await getSession(cookie)).statusCode).toBe(401);
  });
});
