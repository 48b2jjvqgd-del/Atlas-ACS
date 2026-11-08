import { z } from 'zod';

/**
 * Parsers for environment-variable configuration. Environment variables are always strings,
 * so these coerce explicitly and reject ambiguous input rather than guessing.
 */

export const portSchema = z.coerce.number().int().min(0).max(65_535);

export const positiveIntSchema = z.coerce.number().int().positive();

/** Strict boolean parser: only "true"/"false"/"1"/"0" are accepted. */
export const booleanStringSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const logLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** Builds a URL validator restricted to the given protocols (e.g. "postgres:", "amqp:"). */
export function urlWithProtocols(protocols: readonly string[]) {
  return z.url().refine((value) => protocols.includes(new URL(value).protocol), {
    message: `URL must use one of: ${protocols.join(', ')}`,
  });
}

/** Comma-separated list → trimmed, non-empty string array. */
export const commaListSchema = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);
