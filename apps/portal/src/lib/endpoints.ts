import {
  chainVerificationResponseSchema,
  getAuditRecordResponseSchema,
  getTenantConfigurationResponseSchema,
  getTenantResponseSchema,
  listAuditRecordsResponseSchema,
  listPermissionsResponseSchema,
  listPlatformUsersResponseSchema,
  listRolesResponseSchema,
  listTenantUsersResponseSchema,
  listTenantsResponseSchema,
  platformUserSchema,
  roleSchema,
  successEnvelope,
  tenantUserSchema,
  userSummarySchema,
  type AuditQuery,
  type IssuerSettings,
  type TenantStatus,
} from '@atlas/contracts';
import { api } from './api';

/** Typed calls to the ATLAS APIs, each validated against its published contract. */
const query = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
};

export const issuers = {
  list: (
    filter: { status?: TenantStatus; q?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) => api.get(`/v1/tenants${query({ limit: 200, ...filter })}`, listTenantsResponseSchema, signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get(`/v1/tenants/${id}`, getTenantResponseSchema, signal).then((r) => r.data),
  create: (body: {
    slug: string;
    displayName: string;
    internalReference: string;
    settings?: IssuerSettings;
  }) => api.post('/v1/tenants', body, getTenantResponseSchema).then((r) => r.data),
  update: (id: string, body: { displayName?: string; internalReference?: string }) =>
    api.patch(`/v1/tenants/${id}`, body, getTenantResponseSchema).then((r) => r.data),
  setStatus: (id: string, status: Exclude<TenantStatus, 'onboarding'>, reason: string) =>
    api
      .post(`/v1/tenants/${id}/status`, { status, reason }, getTenantResponseSchema)
      .then((r) => r.data),
  configuration: (id: string, signal?: AbortSignal) =>
    api
      .get(`/v1/tenants/${id}/configuration`, getTenantConfigurationResponseSchema, signal)
      .then((r) => r.data),
  saveConfiguration: (id: string, expectedVersion: number, settings: IssuerSettings) =>
    api
      .put(
        `/v1/tenants/${id}/configuration`,
        { expectedVersion, settings },
        getTenantConfigurationResponseSchema,
      )
      .then((r) => r.data),
};

export const identity = {
  roles: (signal?: AbortSignal) =>
    api.get('/v1/identity/roles', listRolesResponseSchema, signal).then((r) => r.data),
  permissions: (signal?: AbortSignal) =>
    api.get('/v1/identity/permissions', listPermissionsResponseSchema, signal).then((r) => r.data),
  createRole: (body: {
    key: string;
    name: string;
    description: string;
    scope: 'platform' | 'tenant';
    permissions: string[];
  }) => api.post('/v1/identity/roles', body, successEnvelope(roleSchema)).then((r) => r.data),
  updateRole: (key: string, body: { name: string; description: string; permissions: string[] }) =>
    api.put(`/v1/identity/roles/${key}`, body, successEnvelope(roleSchema)).then((r) => r.data),
  platformUsers: (signal?: AbortSignal) =>
    api
      .get('/v1/identity/platform-users', listPlatformUsersResponseSchema, signal)
      .then((r) => r.data),
  invitePlatformUser: (body: { email: string; displayName: string; roles: string[] }) =>
    api
      .post('/v1/identity/platform-users', body, successEnvelope(platformUserSchema))
      .then((r) => r.data),
  setPlatformRoles: (userId: string, roles: string[]) =>
    api
      .put(
        `/v1/identity/platform-users/${userId}/roles`,
        { roles },
        successEnvelope(platformUserSchema),
      )
      .then((r) => r.data),
  setUserStatus: (userId: string, status: 'active' | 'disabled', reason: string) =>
    api
      .post(
        `/v1/identity/users/${userId}/status`,
        { status, reason },
        successEnvelope(userSummarySchema),
      )
      .then((r) => r.data),
  tenantUsers: (tenantId: string, signal?: AbortSignal) =>
    api
      .get(`/v1/tenants/${tenantId}/users`, listTenantUsersResponseSchema, signal)
      .then((r) => r.data),
  inviteTenantUser: (
    tenantId: string,
    body: { email: string; displayName: string; roles: string[] },
  ) =>
    api
      .post(`/v1/tenants/${tenantId}/users`, body, successEnvelope(tenantUserSchema))
      .then((r) => r.data),
  setTenantRoles: (tenantId: string, userId: string, roles: string[]) =>
    api
      .put(
        `/v1/tenants/${tenantId}/users/${userId}/roles`,
        { roles },
        successEnvelope(tenantUserSchema),
      )
      .then((r) => r.data),
  removeTenantUser: (tenantId: string, userId: string) =>
    api.delete(`/v1/tenants/${tenantId}/users/${userId}`),
};

export type AuditFilter = Partial<Omit<AuditQuery, 'limit'>> & { limit?: number };

export const audit = {
  platform: (filter: AuditFilter, signal?: AbortSignal) =>
    api.get(
      `/v1/audit/events${query({ limit: 50, ...filter })}`,
      listAuditRecordsResponseSchema,
      signal,
    ),
  tenant: (tenantId: string, filter: AuditFilter, signal?: AbortSignal) =>
    api.get(
      `/v1/tenants/${tenantId}/audit/events${query({ limit: 50, ...filter, tenantId: undefined })}`,
      listAuditRecordsResponseSchema,
      signal,
    ),
  get: (id: string) =>
    api.get(`/v1/audit/events/${id}`, getAuditRecordResponseSchema).then((r) => r.data),
  verify: (chain: string) =>
    api
      .get(`/v1/audit/chains/${chain}/verify`, chainVerificationResponseSchema)
      .then((r) => r.data),
};
