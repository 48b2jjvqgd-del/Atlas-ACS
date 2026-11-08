import { isoTimestampSchema, tenantIdSchema, tenantSlugSchema, z } from '@atlas/schemas';
import { successEnvelope } from '../envelope.js';

/**
 * EXAMPLE CONTRACT — defined, not implemented in Stage 0.
 *
 * GET /v1/tenants/{tenantId}  (issuer-service)
 *
 * Demonstrates the synchronous contract style: a versioned path, a Zod response schema
 * wrapped in the standard success envelope, and additive-only evolution. It mirrors the
 * issuer.tenant table created by the Stage 0 migration.
 */
export const tenantStatusSchema = z.enum(['onboarding', 'active', 'suspended', 'offboarded']);

export const tenantSummarySchema = z.object({
  id: tenantIdSchema,
  slug: tenantSlugSchema,
  displayName: z.string().min(1).max(200),
  status: tenantStatusSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const getTenantParamsSchema = z.object({ tenantId: tenantIdSchema });
export const getTenantResponseSchema = successEnvelope(tenantSummarySchema);

export type TenantSummary = z.infer<typeof tenantSummarySchema>;
