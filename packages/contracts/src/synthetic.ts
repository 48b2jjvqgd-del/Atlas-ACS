import { z } from '@atlas/schemas';

/**
 * Stage 1A synthetic-data rule.
 *
 * Until a later, explicitly authorised stage introduces real records under production controls,
 * every issuer and every user ATLAS stores is synthetic. This is not configurable: there is no
 * environment variable, flag or API field that produces a non-synthetic record. It is enforced
 *
 *   - in the services, which always write is_synthetic = true;
 *   - in the database, by CHECK constraints (is_synthetic must be true; email addresses must use a
 *     reserved domain), so a direct write with service credentials cannot bypass it either;
 *   - in the contracts, which accept only reserved email domains (RFC 2606 / RFC 6761):
 *     *.test, *.example, *.invalid, *.localhost and example.com / example.net / example.org.
 *
 * The pattern below is the single source for both the TypeScript validation and the SQL
 * constraints (PostgreSQL ERE and JavaScript agree on this syntax); a unit test checks that the
 * migrations use exactly this text. How non-synthetic data is to be introduced later is described
 * in docs/decisions/DECISIONS.md (ADR-033).
 */
export const STAGE_1A_SYNTHETIC_ONLY = true as const;

export const syntheticEmailDomainPattern =
  '@(([a-z0-9-]+\\.)*(test|example|invalid|localhost)|([a-z0-9-]+\\.)*example\\.(com|net|org))$';

const syntheticEmailDomain = new RegExp(syntheticEmailDomainPattern);

/** True when the (lower-case) address uses a reserved, non-routable domain. */
export function isSyntheticEmail(email: string): boolean {
  return syntheticEmailDomain.test(email);
}

export const syntheticEmailMessage =
  'Only reserved synthetic email domains are accepted in Stage 1A (.test, .example, .invalid, .localhost, example.com/.net/.org)';

/** A lower-cased email address on a reserved synthetic domain. */
export const syntheticEmailSchema = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase())
  .refine(isSyntheticEmail, syntheticEmailMessage);
