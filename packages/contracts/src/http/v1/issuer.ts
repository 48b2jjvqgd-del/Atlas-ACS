import { isoTimestampSchema, tenantIdSchema, tenantSlugSchema, z } from '@atlas/schemas';
import { successEnvelope } from '../envelope.js';
import { isSyntheticEmail, syntheticEmailMessage } from '../../synthetic.js';

/**
 * Issuer registry — issuer-service (Stage 1A).
 *
 *   GET    /v1/tenants                              list issuers visible to the caller
 *   POST   /v1/tenants                              register an issuer          issuer.create
 *   GET    /v1/tenants/{tenantId}                   issuer profile              issuer.read
 *   PATCH  /v1/tenants/{tenantId}                   edit profile                issuer.update
 *   POST   /v1/tenants/{tenantId}/status            lifecycle transition        issuer.status.manage
 *   GET    /v1/tenants/{tenantId}/configuration     current configuration      issuer.configuration.read
 *   PUT    /v1/tenants/{tenantId}/configuration     new configuration version  issuer.configuration.manage
 *
 * "Tenant" and "issuer" are the same thing: every issuer is one tenant of the platform.
 * A caller without access to an issuer receives 404 for it, never 403, so existence is not leaked.
 */
export const tenantStatusSchema = z.enum(['onboarding', 'active', 'suspended', 'offboarded']);
export type TenantStatus = z.infer<typeof tenantStatusSchema>;

/** Permitted lifecycle transitions. Offboarding is terminal. */
export const tenantStatusTransitions: Record<TenantStatus, readonly TenantStatus[]> = {
  onboarding: ['active', 'offboarded'],
  active: ['suspended', 'offboarded'],
  suspended: ['active', 'offboarded'],
  offboarded: [],
};

export const internalReferenceSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Internal reference is uppercase letters, digits and hyphens');

export const displayNameSchema = z.string().trim().min(1).max(200);

export const tenantSummarySchema = z.object({
  id: tenantIdSchema,
  slug: tenantSlugSchema,
  displayName: z.string().min(1).max(200),
  internalReference: z.string().nullable(),
  status: tenantStatusSchema,
  isSynthetic: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export type TenantSummary = z.infer<typeof tenantSummarySchema>;

export const tenantParamsSchema = z.object({ tenantId: tenantIdSchema });
/** @deprecated use tenantParamsSchema */
export const getTenantParamsSchema = tenantParamsSchema;
export const getTenantResponseSchema = successEnvelope(tenantSummarySchema);

export const listTenantsQuerySchema = z.object({
  status: tenantStatusSchema.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const listTenantsResponseSchema = z.object({
  data: z.array(tenantSummarySchema),
  meta: z.object({
    correlationId: z.string(),
    apiVersion: z.string(),
    total: z.number().int().nonnegative(),
    limit: z.number().int(),
    offset: z.number().int(),
  }),
});

/** Issuer configuration document, version 1. Stored as an immutable, versioned document. */
export const issuerSettingsSchema = z.object({
  timezone: z.string().min(1).max(64).default('Europe/London'),
  defaultLocale: z
    .string()
    .regex(/^[a-z]{2}-[A-Z]{2}$/)
    .default('en-GB'),
  // Stage 1A: reserved synthetic domains only (see synthetic.ts).
  supportContactEmail: z
    .email()
    .max(254)
    .refine((value) => isSyntheticEmail(value.toLowerCase()), syntheticEmailMessage)
    .nullable()
    .default(null),
  supportContactPhone: z
    .string()
    .regex(/^\+?[0-9 ()-]{6,24}$/)
    .nullable()
    .default(null),
  schemeParticipation: z
    .object({ visa: z.boolean().default(false), mastercard: z.boolean().default(false) })
    .default({ visa: false, mastercard: false }),
  branding: z
    .object({
      primaryColour: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .default('#6D8DFF'),
    })
    .default({ primaryColour: '#6D8DFF' }),
});

export type IssuerSettings = z.infer<typeof issuerSettingsSchema>;

export const createTenantBodySchema = z
  .object({
    slug: tenantSlugSchema,
    displayName: displayNameSchema,
    internalReference: internalReferenceSchema,
    settings: issuerSettingsSchema.optional(),
  })
  .strict();

export const updateTenantBodySchema = z
  .object({
    displayName: displayNameSchema.optional(),
    internalReference: internalReferenceSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to change');

export const changeTenantStatusBodySchema = z
  .object({
    status: tenantStatusSchema.exclude(['onboarding']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const tenantConfigurationSchema = z.object({
  tenantId: tenantIdSchema,
  version: z.number().int().positive(),
  settings: issuerSettingsSchema,
  createdAt: isoTimestampSchema,
  createdBy: z.string(),
});

export type TenantConfiguration = z.infer<typeof tenantConfigurationSchema>;

export const getTenantConfigurationResponseSchema = successEnvelope(tenantConfigurationSchema);

export const putTenantConfigurationBodySchema = z
  .object({
    /** Optimistic concurrency: the version the change is based on. */
    expectedVersion: z.number().int().positive(),
    settings: issuerSettingsSchema,
  })
  .strict();
