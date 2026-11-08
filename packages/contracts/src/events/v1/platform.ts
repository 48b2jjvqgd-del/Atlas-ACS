import { kebabIdentifierSchema, z } from '@atlas/schemas';
import { defineEvent } from '../envelope.js';

/**
 * EXAMPLE CONTRACT — the generic shape every configuration-owning service will use to report
 * a change for the audit trail (architectural requirement H: auditability).
 *
 * Only field *names* are carried, never old/new values: values may be sensitive and the owning
 * service remains the system of record. Consumer (planned): audit-service.
 */
export const configurationChangedV1 = defineEvent({
  type: 'atlas.platform.configuration-changed.v1',
  producer: 'issuer-service',
  description: 'A configuration resource was created, updated or deleted.',
  dataSchema: z.object({
    actor: z.object({
      type: z.enum(['user', 'service', 'system']),
      id: z.string().min(1).max(128),
    }),
    resource: z.object({
      type: kebabIdentifierSchema,
      id: z.string().min(1).max(128),
    }),
    action: z.enum(['created', 'updated', 'deleted']),
    changedFields: z.array(z.string().min(1).max(128)).max(200),
    reason: z.string().max(500).optional(),
  }),
});
