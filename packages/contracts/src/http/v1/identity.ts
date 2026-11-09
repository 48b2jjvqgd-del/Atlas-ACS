import { isoTimestampSchema, tenantIdSchema, z } from '@atlas/schemas';
import { permissionScopes, permissionSchema, principalSchema, roleKeySchema } from '../../authz.js';
import { successEnvelope } from '../envelope.js';

/**
 * Identity, roles and permissions — identity-service (Stage 1A).
 *
 * Portal-facing (through api-gateway):
 *   GET  /v1/identity/me                                    the caller's principal and profile
 *   GET  /v1/identity/permissions                           permission catalogue
 *   GET  /v1/identity/roles                                 roles and their permissions
 *   POST /v1/identity/roles                                 create a custom role      platform.roles.manage
 *   PUT  /v1/identity/roles/{roleKey}                       change a custom role      platform.roles.manage
 *   GET  /v1/identity/platform-users                        platform users            platform.users.read
 *   POST /v1/identity/platform-users                        invite a platform user    platform.users.manage
 *   PUT  /v1/identity/platform-users/{userId}/roles         set platform roles        platform.users.manage
 *   POST /v1/identity/users/{userId}/status                 enable / disable a user   (see service)
 *   GET  /v1/tenants/{tenantId}/users                       issuer users              issuer.users.read
 *   POST /v1/tenants/{tenantId}/users                       invite / add issuer user  issuer.users.manage
 *   PUT  /v1/tenants/{tenantId}/users/{userId}/roles        set issuer roles          issuer.users.manage
 *   DELETE /v1/tenants/{tenantId}/users/{userId}            remove from issuer        issuer.users.manage
 *
 * Service-only (service token required; never routed by the gateway):
 *   GET  /v1/internal/principals/{subject}                  resolve an IdP subject to a principal
 *   POST /v1/internal/principals/{subject}/sign-ins         record a sign-in, then resolve
 */
export const userStatusSchema = z.enum(['invited', 'active', 'disabled']);

export const roleSchema = z.object({
  key: roleKeySchema,
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  scope: z.enum(permissionScopes),
  isSystem: z.boolean(),
  permissions: z.array(permissionSchema),
});
export type Role = z.infer<typeof roleSchema>;

export const listRolesResponseSchema = successEnvelope(z.array(roleSchema));

export const permissionInfoSchema = z.object({
  key: permissionSchema,
  description: z.string(),
  category: z.string(),
  scopes: z.array(z.enum(permissionScopes)),
});
export const listPermissionsResponseSchema = successEnvelope(z.array(permissionInfoSchema));

export const createRoleBodySchema = z
  .object({
    key: roleKeySchema,
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).default(''),
    scope: z.enum(permissionScopes),
    permissions: z.array(permissionSchema).min(1).max(100),
  })
  .strict();

export const updateRoleBodySchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500),
    permissions: z.array(permissionSchema).min(1).max(100),
  })
  .strict();

export const roleParamsSchema = z.object({ roleKey: roleKeySchema });

export const userSummarySchema = z.object({
  id: z.uuid(),
  email: z.email(),
  displayName: z.string(),
  status: userStatusSchema,
  isSynthetic: z.boolean(),
  lastSignInAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
});
export type UserSummary = z.infer<typeof userSummarySchema>;

export const platformUserSchema = userSummarySchema.extend({ roles: z.array(roleKeySchema) });
export type PlatformUser = z.infer<typeof platformUserSchema>;
export const listPlatformUsersResponseSchema = successEnvelope(z.array(platformUserSchema));

export const tenantUserSchema = userSummarySchema.extend({
  tenantId: tenantIdSchema,
  roles: z.array(roleKeySchema),
});
export type TenantUser = z.infer<typeof tenantUserSchema>;
export const listTenantUsersResponseSchema = successEnvelope(z.array(tenantUserSchema));

const emailInput = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());

export const inviteUserBodySchema = z
  .object({
    email: emailInput,
    displayName: z.string().trim().min(1).max(200),
    roles: z.array(roleKeySchema).min(1).max(20),
  })
  .strict();

export const setRolesBodySchema = z.object({ roles: z.array(roleKeySchema).max(20) }).strict();

export const userParamsSchema = z.object({ userId: z.uuid() });
export const tenantUserParamsSchema = z.object({ tenantId: tenantIdSchema, userId: z.uuid() });

export const setUserStatusBodySchema = z
  .object({
    status: z.enum(['active', 'disabled']),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const meResponseSchema = successEnvelope(principalSchema);

export const principalResponseSchema = successEnvelope(principalSchema);
export const subjectParamsSchema = z.object({ subject: z.string().min(1).max(255) });
