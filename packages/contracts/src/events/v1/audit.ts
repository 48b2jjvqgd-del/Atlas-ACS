import { isoTimestampSchema, tenantIdSchema, z } from '@atlas/schemas';
import { defineEvent } from '../envelope.js';

/**
 * Audit activity — the single event every audited action produces (Stage 1A).
 *
 * Producers write it through a transactional outbox (PostgreSQL services) or a durable Valkey
 * outbox (api-gateway), so an audited change cannot commit without its audit event. The event id
 * becomes the audit record id, which makes consumption idempotent.
 *
 * Data-minimisation rules, enforced here as well as by producers:
 *  - `changes` carries before/after values only for an allow-listed set of non-sensitive fields;
 *    values are short scalars. Field names that look like credentials are rejected outright.
 *  - Never: passwords, tokens, secrets, session identifiers, card data, free-form payloads.
 */
const sensitiveFragment = /(password|passwd|secret|token|credential|cookie|authorization|cvv|cvc)/i;
const sensitiveSegment = /^(pan|otp|pin|sessionid|apikey)$/i;

/** True when a (dotted) field name looks like it could hold a credential or card data. */
export function isSensitiveFieldName(name: string): boolean {
  return name
    .split('.')
    .some((segment) => sensitiveFragment.test(segment) || sensitiveSegment.test(segment));
}

export const auditFieldNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9.]*$/, 'Field names are dotted identifiers')
  .refine((name) => !isSensitiveFieldName(name), 'Sensitive fields must never be audited by value');

export const auditScalarSchema = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

export const auditActionSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(
    /^[a-z]+(?:\.[a-z]+(?:-[a-z]+)*)+$/,
    'Actions are dotted lowercase, e.g. issuer.suspended',
  );

export const auditActorSchema = z.object({
  type: z.enum(['user', 'service', 'system', 'anonymous']),
  /** User id (ATLAS identity), IdP subject, service name, or "anonymous". */
  id: z.string().min(1).max(128),
  displayName: z.string().max(200).optional(),
});

export const auditResourceSchema = z.object({
  type: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  id: z.string().min(1).max(128),
  name: z.string().max(200).optional(),
});

export const auditOutcomeSchema = z.enum(['success', 'failure', 'denied']);

export const auditChangeSchema = z.object({
  field: auditFieldNameSchema,
  before: auditScalarSchema,
  after: auditScalarSchema,
});

export const activityRecordedV1 = defineEvent({
  type: 'atlas.platform.activity-recorded.v1',
  producers: ['api-gateway', 'identity-service', 'issuer-service', 'audit-service'],
  description: 'An audited action happened: who did what, to which resource, with what result.',
  dataSchema: z.object({
    occurredAt: isoTimestampSchema,
    actor: auditActorSchema,
    /** Issuer the action concerns, when tenant-scoped. Platform-level actions omit it. */
    tenantId: tenantIdSchema.optional(),
    action: auditActionSchema,
    resource: auditResourceSchema,
    outcome: auditOutcomeSchema,
    changes: z.array(auditChangeSchema).max(50).optional(),
    /** Small, non-sensitive context (e.g. permission checked, HTTP method, reason code). */
    metadata: z.record(auditFieldNameSchema, auditScalarSchema).optional(),
    reason: z.string().max(500).optional(),
  }),
});

export type ActivityRecorded = z.infer<typeof activityRecordedV1.dataSchema>;
export type AuditChange = z.infer<typeof auditChangeSchema>;
