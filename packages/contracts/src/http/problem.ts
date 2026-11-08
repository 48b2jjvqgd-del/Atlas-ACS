import { errorCodeList } from '@atlas/shared';
import { correlationIdSchema, z } from '@atlas/schemas';

/**
 * Error response contract — RFC 9457 "Problem Details for HTTP APIs", served as
 * application/problem+json, with ATLAS extension members:
 *   code          stable machine-readable error code (see @atlas/shared errorCodes)
 *   correlationId correlation ID of the failing request, for support and log lookup
 *   issues        field-level validation issues (VALIDATION_FAILED only)
 *
 * This envelope applies to ATLAS platform APIs only. EMV 3DS protocol endpoints must respond
 * with protocol-defined messages (e.g. the EMV 3DS Error Message), never with this shape.
 */
export const errorCodeSchema = z.enum(errorCodeList);

export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: errorCodeSchema,
  correlationId: correlationIdSchema,
  issues: z.array(validationIssueSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/** Problem "type" URIs are URNs so that no external documentation host is implied. */
export function problemTypeFor(code: z.infer<typeof errorCodeSchema>): string {
  return `urn:atlas:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
