import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Server-side portal sessions (backend-for-frontend).
 *
 * The browser holds only an opaque, random session id in an HttpOnly cookie. Everything else —
 * including the identity provider's access, refresh and ID tokens — stays here, in Valkey:
 *
 *   key    atlas:api-gateway:session:<sha256(session id)>   (the raw id is never stored)
 *   value  AES-256-GCM encrypted JSON, keyed by SESSION_ENCRYPTION_KEY
 *   TTL    until the idle or absolute expiry, whichever is sooner
 *
 * Idle expiry slides with activity but never passes the absolute expiry. Expired sessions cannot
 * be used even if Valkey has not yet evicted them.
 */
export interface SessionRecord {
  subject: string;
  idpSessionId: string | null;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string | null;
  idToken: string | null;
  csrfToken: string;
  amr: string[];
  authenticatedAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
}

export interface LoginState {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

export class SessionStore {
  readonly #key: Buffer;

  constructor(
    private readonly redis: Redis,
    encryptionKeyHex: string,
    private readonly timeouts: { idleMs: number; absoluteMs: number },
  ) {
    this.#key = Buffer.from(encryptionKeyHex, 'hex');
    if (this.#key.length !== 32)
      throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }

  static newId(): string {
    return randomBytes(32).toString('base64url');
  }

  static newCsrfToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private storageKey(id: string): string {
    return `session:${createHash('sha256').update(id).digest('hex')}`;
  }

  private encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private decrypt<T>(stored: string): T | undefined {
    try {
      const raw = Buffer.from(stored, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      return undefined; // tampered with, or encrypted under a previous key
    }
  }

  /** A new session starting now, with both expiries computed. */
  create(
    fields: Omit<
      SessionRecord,
      'csrfToken' | 'authenticatedAt' | 'absoluteExpiresAt' | 'idleExpiresAt'
    >,
  ): SessionRecord {
    const now = Date.now();
    return {
      ...fields,
      csrfToken: SessionStore.newCsrfToken(),
      authenticatedAt: now,
      absoluteExpiresAt: now + this.timeouts.absoluteMs,
      idleExpiresAt: Math.min(now + this.timeouts.idleMs, now + this.timeouts.absoluteMs),
    };
  }

  async save(id: string, session: SessionRecord): Promise<void> {
    const ttl = Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - Date.now();
    if (ttl <= 0) {
      await this.destroy(id);
      return;
    }
    await this.redis.set(this.storageKey(id), this.encrypt(session), 'PX', ttl);
  }

  /** Loads a session; returns `expired` for one past its idle or absolute expiry. */
  async load(id: string): Promise<{ session: SessionRecord } | { expired: true } | undefined> {
    const stored = await this.redis.get(this.storageKey(id));
    if (!stored) return undefined;
    const session = this.decrypt<SessionRecord>(stored);
    if (!session) return undefined;
    const now = Date.now();
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      await this.destroy(id);
      return { expired: true };
    }
    return { session };
  }

  /** Slides the idle expiry (never beyond the absolute expiry). */
  touch(session: SessionRecord): SessionRecord {
    return {
      ...session,
      idleExpiresAt: Math.min(Date.now() + this.timeouts.idleMs, session.absoluteExpiresAt),
    };
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(this.storageKey(id));
  }

  async saveLoginState(state: string, value: LoginState): Promise<void> {
    await this.redis.set(`login:${state}`, this.encrypt(value), 'PX', 10 * 60_000);
  }

  /** Single use: the state is deleted as it is read. */
  async takeLoginState(state: string): Promise<LoginState | undefined> {
    const key = `login:${state}`;
    const stored = await this.redis.getdel(key);
    return stored ? this.decrypt<LoginState>(stored) : undefined;
  }
}

/** Constant-time comparison of two tokens. */
export function tokensMatch(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------- cookies

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!(name in result)) result[name] = decodeURIComponent(value);
  }
  return result;
}

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds?: number;
  path?: string;
}

export function serialiseCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined)
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join('; ');
}

/** `__Host-` cookies require Secure, Path=/ and no Domain: the browser then pins them to this host. */
export function cookieNames(secure: boolean) {
  return {
    session: secure ? '__Host-atlas_session' : 'atlas_session',
    login: secure ? '__Host-atlas_login' : 'atlas_login',
  };
}
