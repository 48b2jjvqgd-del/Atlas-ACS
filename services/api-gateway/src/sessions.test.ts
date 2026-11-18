import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  cookieNames,
  deriveRateLimitKey,
  parseCookieHeader,
  parseCookies,
  serialiseCookie,
  sessionCookieFrom,
  SessionStore,
  tokensMatch,
} from './sessions.js';

/** Minimal in-memory stand-in for the Valkey commands the store uses. */
function fakeRedis() {
  const data = new Map<string, string>();
  return {
    data,
    client: {
      set: async (key: string, value: string) => void data.set(key, value),
      get: async (key: string) => data.get(key) ?? null,
      getdel: async (key: string) => {
        const value = data.get(key) ?? null;
        data.delete(key);
        return value;
      },
      del: async (key: string) => void data.delete(key),
    } as unknown as Redis,
  };
}

const key = 'a'.repeat(64);
const fields = {
  subject: 'user-1',
  userId: '7c000000-0000-4000-8000-000000000001',
  displayName: 'Test User',
  idpSessionId: 'sid',
  accessToken: 'secret-access-token',
  accessExpiresAt: Date.now() + 300_000,
  refreshToken: 'secret-refresh-token',
  idToken: 'id-token',
  amr: ['pwd'],
};

describe('SessionStore', () => {
  it('stores sessions encrypted under a hash of the id, never the raw id or tokens', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 3_600_000 });
    const id = SessionStore.newId();
    await store.save(id, store.create(fields));
    const [storedKey, storedValue] = [...redis.data.entries()][0]!;
    expect(storedKey).not.toContain(id);
    expect(storedValue).not.toContain('secret-access-token');
    const loaded = await store.load(id);
    expect(loaded && 'session' in loaded && loaded.session.accessToken).toBe('secret-access-token');
  });

  it('rejects data encrypted with another key or tampered with', async () => {
    const redis = fakeRedis();
    const id = SessionStore.newId();
    const writer = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 3_600_000 });
    await writer.save(id, writer.create(fields));
    const reader = new SessionStore(redis.client, 'b'.repeat(64), {
      idleMs: 60_000,
      absoluteMs: 3_600_000,
    });
    expect(await reader.load(id)).toBeUndefined();
    const [storedKey, value] = [...redis.data.entries()][0]!;
    redis.data.set(storedKey, `${value.slice(0, -4)}AAAA`);
    expect(await writer.load(id)).toBeUndefined();
  });

  it('expires idle sessions and never extends past the absolute expiry', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 120_000 });
    const id = SessionStore.newId();
    const session = store.create(fields);
    expect(session.idleExpiresAt - session.authenticatedAt).toBe(60_000);
    const later = { ...session, absoluteExpiresAt: Date.now() + 10_000 };
    expect(store.touch(later).idleExpiresAt).toBe(later.absoluteExpiresAt);

    await store.save(id, { ...session, idleExpiresAt: Date.now() + 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.load(id)).toMatchObject({
      expired: true,
      previous: { userId: fields.userId },
    });
    expect(redis.data.size).toBe(0);
  });

  it('makes sign-in state single-use', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 120_000 });
    await store.saveLoginState('state-1', {
      codeVerifier: 'v',
      nonce: 'n',
      returnTo: '/',
      createdAt: 1,
    });
    expect(await store.takeLoginState('state-1')).toMatchObject({ nonce: 'n' });
    expect(await store.takeLoginState('state-1')).toBeUndefined();
  });

  it('reports a session active only when it exists, authenticates and has not expired', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 3_600_000 });
    const id = SessionStore.newId();
    expect(await store.isActive(id)).toBe(false);
    await store.save(id, store.create(fields));
    expect(await store.isActive(id)).toBe(true);
    expect(await store.isActive(SessionStore.newId())).toBe(false);

    // Encrypted under another key, or tampered with: not active.
    const other = new SessionStore(redis.client, 'b'.repeat(64), {
      idleMs: 60_000,
      absoluteMs: 3_600_000,
    });
    expect(await other.isActive(id)).toBe(false);

    // Expired but not yet evicted: not active, and (unlike load) nothing is destroyed.
    await store.save(id, { ...store.create(fields), idleExpiresAt: Date.now() + 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.isActive(id)).toBe(false);
    expect(redis.data.size).toBe(1);
  });

  it('derives a rate-limit identity that reveals neither the id nor its storage key', async () => {
    const redis = fakeRedis();
    const store = new SessionStore(redis.client, key, { idleMs: 60_000, absoluteMs: 3_600_000 });
    const id = SessionStore.newId();
    await store.save(id, store.create(fields));
    const identity = store.rateLimitIdentity(id);
    expect(identity).toMatch(/^[0-9a-f]{32}$/);
    expect(store.rateLimitIdentity(id)).toBe(identity);
    expect(store.rateLimitIdentity(SessionStore.newId())).not.toBe(identity);
    expect(identity).not.toContain(id.slice(0, 16));
    const [storageKey] = [...redis.data.keys()];
    expect(storageKey).not.toContain(identity);
  });

  it('derives the rate-limit key with HKDF-SHA-256 under its own context, not the raw key', () => {
    const sessionKey = Buffer.from(key, 'hex');
    const derived = deriveRateLimitKey(sessionKey);
    expect(derived).toHaveLength(32);
    // Independent known answer: HKDF-SHA-256, empty salt, the purpose-specific info string.
    const expected = Buffer.from(
      hkdfSync(
        'sha256',
        sessionKey,
        Buffer.alloc(0),
        'atlas/api-gateway/rate-limit-identity/hmac-sha256/v1',
        32,
      ),
    );
    expect(derived.equals(expected)).toBe(true);
    // Purpose-separated: not the session key, and not what any other context would produce.
    expect(derived.equals(sessionKey)).toBe(false);
    const otherPurpose = Buffer.from(
      hkdfSync('sha256', sessionKey, Buffer.alloc(0), 'atlas/api-gateway/other', 32),
    );
    expect(derived.equals(otherPurpose)).toBe(false);
    // Stable for the same configured key; different for a different one.
    expect(deriveRateLimitKey(Buffer.from(key, 'hex')).equals(derived)).toBe(true);
    expect(deriveRateLimitKey(Buffer.from('b'.repeat(64), 'hex')).equals(derived)).toBe(false);
  });

  it('computes rate-limit identities under the derived key, never the session key', () => {
    const timeouts = { idleMs: 60_000, absoluteMs: 3_600_000 };
    const store = new SessionStore(fakeRedis().client, key, timeouts);
    const id = SessionStore.newId();
    const sessionKey = Buffer.from(key, 'hex');
    const hmac = (hmacKey: Buffer) => createHmac('sha256', hmacKey).update(id).digest('hex');
    expect(store.rateLimitIdentity(id)).toBe(hmac(deriveRateLimitKey(sessionKey)).slice(0, 32));
    expect(store.rateLimitIdentity(id)).not.toBe(hmac(sessionKey).slice(0, 32));
    // Stable across gateway instances (restarts, replicas) sharing the configured key.
    expect(new SessionStore(fakeRedis().client, key, timeouts).rateLimitIdentity(id)).toBe(
      store.rateLimitIdentity(id),
    );
    expect(
      new SessionStore(fakeRedis().client, 'b'.repeat(64), timeouts).rateLimitIdentity(id),
    ).not.toBe(store.rateLimitIdentity(id));
    // The derived key is private state: not enumerable, not serialised.
    const derivedHex = deriveRateLimitKey(sessionKey).toString('hex');
    expect(JSON.stringify(store)).not.toContain(derivedHex);
    expect(Object.values(store).map(String).join()).not.toContain(derivedHex);
  });

  it('requires a 32-byte encryption key', () => {
    expect(
      () => new SessionStore(fakeRedis().client, 'abcd', { idleMs: 1, absoluteMs: 1 }),
    ).toThrow(/32 bytes/);
  });
});

describe('cookies and CSRF tokens', () => {
  it('issues HttpOnly, SameSite=Lax, host-only cookies (Secure when configured)', () => {
    const header = serialiseCookie(cookieNames(true).session, 'abc', { secure: true });
    expect(header).toMatch(/^__Host-atlas_session=abc; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    expect(serialiseCookie('x', '', { secure: false, maxAgeSeconds: 0 })).toContain('Max-Age=0');
    expect(parseCookies('a=1; __Host-atlas_session=xyz')).toEqual({
      a: '1',
      '__Host-atlas_session': 'xyz',
    });
  });

  it('parses normal cookies and decodes valid percent-encoding', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=hello%20world; b=x%3Dy;c=;  d = 4 ')).toEqual({
      a: 'hello world',
      b: 'x=y',
      c: '',
      d: '4',
    });
    // Round trip with what the gateway itself issues.
    const issued = serialiseCookie('n', 'v; with=specials%', { secure: false }).split(';')[0];
    expect(parseCookies(issued)).toEqual({ n: 'v; with=specials%' });
  });

  it('never throws on malformed encoding and keeps every other cookie (F-12)', () => {
    for (const bad of ['%', '%E0%A4%A', '%zz', '%C0%AF', '%uD800', '%%%']) {
      expect(() => parseCookies(`x=${bad}`), bad).not.toThrow();
      expect(parseCookies(`x=${bad}`), bad).toEqual({});
      expect(parseCookies(`a=1; x=${bad}; __Host-atlas_session=abc`), bad).toEqual({
        a: '1',
        '__Host-atlas_session': 'abc',
      });
    }
    expect(parseCookieHeader('a=1; x=%; y=%zz').malformed).toEqual(new Set(['x', 'y']));
  });

  it('keeps the first occurrence of a name, even when it is malformed', () => {
    expect(parseCookies('a=1; a=2')).toEqual({ a: '1' });
    // A broken first value is not replaced by a later duplicate.
    expect(parseCookies('a=%; a=2')).toEqual({});
  });

  it('treats prototype property names as ordinary cookies', () => {
    const parsed = parseCookies('__proto__=x; constructor=y; toString=z');
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.entries(parsed)).toEqual([
      ['__proto__', 'x'],
      ['constructor', 'y'],
      ['toString', 'z'],
    ]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // global prototype untouched
  });

  it('accepts only well-formed session ids from the session cookie', () => {
    const name = cookieNames(true).session;
    const id = SessionStore.newId();
    expect(sessionCookieFrom(`${name}=${id}`, name)).toEqual({ id });
    expect(sessionCookieFrom(`theme=%; ${name}=${id}`, name)).toEqual({ id });
    expect(sessionCookieFrom('theme=dark', name)).toBeUndefined();
    expect(sessionCookieFrom(undefined, name)).toBeUndefined();
    for (const bad of ['%', '%E0%A4%A', '', 'abc', `${id}x`, id.slice(1), `${id.slice(1)}=`]) {
      expect(sessionCookieFrom(`${name}=${bad}`, name), bad).toEqual({ malformed: true });
    }
    // A malformed first occurrence is not rescued by a valid duplicate...
    expect(sessionCookieFrom(`${name}=%; ${name}=${id}`, name)).toEqual({ malformed: true });
    // ...and a valid first occurrence is not spoiled by a malformed one after it.
    for (const bad of ['%', '%E0%A4%A', 'abc', SessionStore.newId()]) {
      expect(sessionCookieFrom(`${name}=${id}; ${name}=${bad}`, name), bad).toEqual({ id });
    }
  });

  it('compares CSRF tokens in constant time and rejects missing or different tokens', () => {
    expect(tokensMatch('same-token', 'same-token')).toBe(true);
    expect(tokensMatch('other-token', 'same-token')).toBe(false);
    expect(tokensMatch(undefined, 'same-token')).toBe(false);
  });
});
