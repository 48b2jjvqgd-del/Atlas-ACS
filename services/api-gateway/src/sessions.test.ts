import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import {
  cookieNames,
  parseCookies,
  serialiseCookie,
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

  it('compares CSRF tokens in constant time and rejects missing or different tokens', () => {
    expect(tokensMatch('same-token', 'same-token')).toBe(true);
    expect(tokensMatch('other-token', 'same-token')).toBe(false);
    expect(tokensMatch(undefined, 'same-token')).toBe(false);
  });
});
