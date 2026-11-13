import { isoTimestampSchema, z } from '@atlas/schemas';
import { principalSchema } from '../../authz.js';
import { successEnvelope } from '../envelope.js';

/**
 * Portal session — api-gateway backend-for-frontend (Stage 1A).
 *
 *   GET  /v1/auth/login?returnTo=/path   302 to the identity provider (authorisation code + PKCE)
 *   GET  /v1/auth/callback               302 back to the portal; sets the session cookie
 *   POST /v1/auth/logout                 ends the session; returns the IdP end-session URL
 *   GET  /v1/session                     the current session, or 401
 *
 * Tokens never reach the browser. The browser holds one opaque, HttpOnly session cookie; the
 * gateway keeps tokens server-side (Valkey) and refreshes them. State-changing requests must
 * carry the session's CSRF token in the x-atlas-csrf header.
 */
export const sessionSchema = z.object({
  principal: principalSchema,
  csrfToken: z.string().min(32),
  authenticatedAt: isoTimestampSchema,
  /** Absolute expiry: the session ends at this time regardless of activity. */
  expiresAt: isoTimestampSchema,
  /** Idle expiry: extended by activity, never beyond expiresAt. */
  idleExpiresAt: isoTimestampSchema,
  /** Whether the sign-in used a second factor (from the IdP's amr claim). */
  mfa: z.boolean(),
  /** IdP account console, for password and two-factor management. */
  accountUrl: z.url().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionResponseSchema = successEnvelope(sessionSchema);

export const logoutResponseSchema = successEnvelope(
  z.object({ endSessionUrl: z.url().nullable() }),
);

export const csrfHeader = 'x-atlas-csrf';
