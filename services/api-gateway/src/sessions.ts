import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
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
  /** ATLAS user id and name, for audit records. */
  userId: string;
  displayName: string;
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

/**
 * HKDF-SHA-256 context for the rate-limit identity key. Unique to this purpose, so the derived key
 * is cryptographically independent of the session encryption key and of any other key that may
 * later be derived from it. Changing it rotates every rate-limit identity (harmless: buckets are
 * short-lived counters).
 */
export const RATE_LIMIT_KEY_INFO = 'atlas/api-gateway/rate-limit-identity/hmac-sha256/v1';

/**
 * Derives the rate-limit HMAC key from the session encryption key with HKDF-SHA-256 (RFC 5869).
 * Deterministic for a given input key; no extra secret to configure. The input key is already
 * uniformly random (32 bytes), so a zero-length salt is appropriate (RFC 5869 section 3.1).
 */
export function deriveRateLimitKey(sessionEncryptionKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', sessionEncryptionKey, Buffer.alloc(0), RATE_LIMIT_KEY_INFO, 32),
  );
}

export class SessionStore {
  readonly #key: Buffer;
  /** Purpose-separated from #key (HKDF); used only for rate-limit identities, never logged. */
  readonly #rateLimitKey: Buffer;

  constructor(
    private readonly redis: Redis,
    encryptionKeyHex: string,
    private readonly timeouts: { idleMs: number; absoluteMs: number },
  ) {
    this.#key = Buffer.from(encryptionKeyHex, 'hex');
    if (this.#key.length !== 32)
      throw new Error('SESSION_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
    this.#rateLimitKey = deriveRateLimitKey(this.#key);
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

  /**
   * A stable, non-reversible rate-limit identity for a session: HMAC-SHA-256 of the id under a
   * key derived from the session key with HKDF (deriveRateLimitKey), truncated to 128 bits. The
   * raw session encryption key is never used as an HMAC key. It reveals neither the session id
   * nor the session's storage key, so a reader of Valkey or the logs cannot use it to find or
   * replay a session.
   */
  rateLimitIdentity(id: string): string {
    return createHmac('sha256', this.#rateLimitKey).update(id).digest('hex').slice(0, 32);
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
  async load(
    id: string,
  ): Promise<{ session: SessionRecord } | { expired: true; previous: SessionRecord } | undefined> {
    const stored = await this.redis.get(this.storageKey(id));
    if (!stored) return undefined;
    const session = this.decrypt<SessionRecord>(stored);
    if (!session) return undefined;
    const now = Date.now();
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      await this.destroy(id);
      return { expired: true, previous: session };
    }
    return { session };
  }

  /**
   * True only when a session with this id exists, decrypts and authenticates under this
   * gateway's key, and is within both expiries. No side effects (nothing is destroyed, slid or
   * audited): used to decide whether a request may have a per-session rate-limit identity.
   */
  async isActive(id: string): Promise<boolean> {
    const stored = await this.redis.get(this.storageKey(id));
    if (!stored) return false;
    const session = this.decrypt<SessionRecord>(stored);
    if (!session) return false;
    const now = Date.now();
    return now < session.idleExpiresAt && now < session.absoluteExpiresAt;
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

/**
 * Parses a Cookie header. Never throws: the header is client-controlled.
 *
 *  - A value whose percent-encoding is invalid is dropped; other cookies are unaffected
 *    (final review F-12: one malformed cookie used to make every route answer 500).
 *  - The first occurrence of a name wins, even when it is malformed: a later duplicate cannot
 *    take its place, so injecting a broken cookie never changes which value is used.
 *  - The result has no prototype, so names such as `__proto__` or `constructor` are plain keys.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  return parseCookieHeader(header).values;
}

/** As parseCookies, and also names the cookies whose (first) value was malformed. */
export function parseCookieHeader(header: string | undefined): {
  values: Record<string, string>;
  malformed: ReadonlySet<string>;
} {
  const values = Object.create(null) as Record<string, string>;
  const malformed = new Set<string>();
  const seen = new Set<string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const value = decodeCookieValue(part.slice(index + 1).trim());
    if (value === undefined) malformed.add(name);
    else values[name] = value;
  }
  return { values, malformed };
}

function decodeCookieValue(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // malformed percent-encoding (URIError)
  }
}

/** Session ids are exactly what newId() produces: 32 random bytes, base64url, no padding. */
const SESSION_ID_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export type SessionCookie = { id: string } | { malformed: true } | undefined;

/**
 * The browser's session id from a Cookie header: `{ id }` for a well-formed id, `{ malformed }`
 * when the cookie is present but undecodable or not of the form newId() produces, undefined when
 * absent. A malformed value is never looked up, never used as a rate-limit identity and never
 * authenticates anything.
 */
export function sessionCookieFrom(header: string | undefined, cookieName: string): SessionCookie {
  const { values, malformed } = parseCookieHeader(header);
  if (malformed.has(cookieName)) return { malformed: true };
  if (!Object.hasOwn(values, cookieName)) return undefined;
  return SESSION_ID_FORMAT.test(values[cookieName]!)
    ? { id: values[cookieName]! }
    : { malformed: true };
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
