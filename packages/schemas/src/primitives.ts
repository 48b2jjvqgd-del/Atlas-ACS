import { z } from 'zod';

/**
 * Reusable validation primitives. Contracts compose these; they should never be redefined
 * ad hoc inside a service. Changing a primitive changes every contract that uses it, so
 * tightening a primitive is a breaking change and must be versioned.
 */

export const uuidSchema = z.uuid();

/**
 * Correlation IDs flow across every hop (HTTP and messaging). Accept UUIDs or opaque tokens
 * from trusted upstream systems, but constrain the character set and length so the value is
 * safe to log and to echo back in a response header.
 */
export const correlationIdSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Correlation ID contains unsupported characters');

/** Tenant (issuer) identifiers are UUIDs, never human-entered names. */
export const tenantIdSchema = z.uuid();

/** URL-safe tenant slug, used for display and routing only — never as an authorisation key. */
export const tenantSlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'Slug must be lowercase alphanumeric with hyphens');

export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'Expected a semantic version');

/** Kebab-case identifier used for service names, event names and similar keys. */
export const kebabIdentifierSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a kebab-case identifier');
