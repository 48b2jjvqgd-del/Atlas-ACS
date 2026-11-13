import { isoTimestampSchema, tenantIdSchema, z } from '@atlas/schemas';
import {
  auditActionSchema,
  auditActorSchema,
  auditChangeSchema,
  auditOutcomeSchema,
  auditResourceSchema,
  auditScalarSchema,
} from '../../events/v1/audit.js';
import { successEnvelope } from '../envelope.js';

/**
 * Audit trail — audit-service (Stage 1A).
 *
 *   GET /v1/audit/events                          platform-wide trail          audit.read (platform)
 *   GET /v1/audit/events/{eventId}                one record                   audit.read
 *   GET /v1/audit/chains/{chain}/verify           verify a hash chain          audit.verify
 *   GET /v1/tenants/{tenantId}/audit/events       one issuer's trail           audit.read (that issuer)
 *
 * Records are append-only. There is no update or delete endpoint, and the service's database
 * role cannot update or delete them.
 */
export const auditRecordSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  occurredAt: isoTimestampSchema,
  recordedAt: isoTimestampSchema,
  actor: auditActorSchema,
  tenantId: tenantIdSchema.nullable(),
  action: auditActionSchema,
  resource: auditResourceSchema,
  outcome: auditOutcomeSchema,
  correlationId: z.string(),
  sourceService: z.string(),
  changes: z.array(auditChangeSchema).nullable(),
  metadata: z.record(z.string(), auditScalarSchema).nullable(),
  reason: z.string().nullable(),
  chain: z.string(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  previousHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export const auditQuerySchema = z.object({
  tenantId: tenantIdSchema.optional(),
  action: z.string().max(80).optional(),
  actorId: z.string().max(128).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.string().max(128).optional(),
  outcome: auditOutcomeSchema.optional(),
  from: isoTimestampSchema.optional(),
  to: isoTimestampSchema.optional(),
  /** Keyset pagination: return records with sequence below this value. */
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const listAuditRecordsResponseSchema = z.object({
  data: z.array(auditRecordSchema),
  meta: z.object({
    correlationId: z.string(),
    apiVersion: z.string(),
    /** Pass as `before` to fetch the next (older) page; null when there are no more. */
    nextBefore: z.number().int().nullable(),
  }),
});

export const getAuditRecordResponseSchema = successEnvelope(auditRecordSchema);

/** "platform" or a tenant id. */
export const auditChainParamsSchema = z.object({
  chain: z.union([z.literal('platform'), tenantIdSchema]),
});

export const chainVerificationSchema = z.object({
  chain: z.string(),
  records: z.number().int().nonnegative(),
  valid: z.boolean(),
  /** First record whose hash does not match, when invalid. */
  firstInvalidSequence: z.number().int().nullable(),
  headHash: z.string().nullable(),
  verifiedAt: isoTimestampSchema,
});
export const chainVerificationResponseSchema = successEnvelope(chainVerificationSchema);
