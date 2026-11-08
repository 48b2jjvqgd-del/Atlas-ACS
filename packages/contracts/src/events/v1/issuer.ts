import { tenantIdSchema, tenantSlugSchema, z } from '@atlas/schemas';
import { defineEvent } from '../envelope.js';

/**
 * EXAMPLE CONTRACT — published by issuer-service when a tenant is registered.
 * Consumers (planned): audit-service, reporting-service.
 */
export const tenantCreatedV1 = defineEvent({
  type: 'atlas.issuer.tenant-created.v1',
  producer: 'issuer-service',
  description: 'A new issuer tenant has been registered on the platform.',
  dataSchema: z.object({
    tenantId: tenantIdSchema,
    slug: tenantSlugSchema,
    displayName: z.string().min(1).max(200),
  }),
});
