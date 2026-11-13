import { toJsonSchema, type z } from '@atlas/schemas';
import { eventEnvelopeSchema, type EventContract } from './events/envelope.js';
import { configurationChangedV1 } from './events/v1/platform.js';
import { activityRecordedV1 } from './events/v1/audit.js';
import { tenantCreatedV1 } from './events/v1/issuer.js';
import {
  chainVerificationResponseSchema,
  getAuditRecordResponseSchema,
  listAuditRecordsResponseSchema,
} from './http/v1/audit.js';
import {
  listPermissionsResponseSchema,
  listPlatformUsersResponseSchema,
  listRolesResponseSchema,
  listTenantUsersResponseSchema,
  meResponseSchema,
} from './http/v1/identity.js';
import { sessionResponseSchema } from './http/v1/session.js';
import { problemDetailsSchema } from './http/problem.js';
import {
  livenessResponseSchema,
  readinessResponseSchema,
  serviceInfoSchema,
} from './http/v1/health.js';
import {
  getTenantConfigurationResponseSchema,
  getTenantResponseSchema,
  listTenantsResponseSchema,
} from './http/v1/issuer.js';
import { platformServicesResponseSchema } from './http/v1/platform.js';

/** Every published event contract. Adding a contract here publishes its JSON Schema. */
export const eventContracts: readonly EventContract[] = [
  tenantCreatedV1,
  configurationChangedV1,
  activityRecordedV1,
];

/** Every published HTTP schema, keyed by a stable contract identifier. */
export const httpSchemas: Readonly<Record<string, z.ZodType>> = {
  'http.problem-details': problemDetailsSchema,
  'http.v1.liveness-response': livenessResponseSchema,
  'http.v1.readiness-response': readinessResponseSchema,
  'http.v1.service-info': serviceInfoSchema,
  'http.v1.platform-services-response': platformServicesResponseSchema,
  'http.v1.get-tenant-response': getTenantResponseSchema,
  'http.v1.list-tenants-response': listTenantsResponseSchema,
  'http.v1.get-tenant-configuration-response': getTenantConfigurationResponseSchema,
  'http.v1.me-response': meResponseSchema,
  'http.v1.list-roles-response': listRolesResponseSchema,
  'http.v1.list-permissions-response': listPermissionsResponseSchema,
  'http.v1.list-platform-users-response': listPlatformUsersResponseSchema,
  'http.v1.list-tenant-users-response': listTenantUsersResponseSchema,
  'http.v1.list-audit-records-response': listAuditRecordsResponseSchema,
  'http.v1.get-audit-record-response': getAuditRecordResponseSchema,
  'http.v1.chain-verification-response': chainVerificationResponseSchema,
  'http.v1.session-response': sessionResponseSchema,
};

/** All contracts as JSON Schema documents, for non-TypeScript consumers and documentation. */
export function exportJsonSchemas(): Record<string, object> {
  const documents: Record<string, object> = {
    'event.envelope': toJsonSchema(eventEnvelopeSchema, {
      id: 'urn:atlas:contract:event-envelope',
    }),
  };
  for (const [key, schema] of Object.entries(httpSchemas)) {
    documents[key] = toJsonSchema(schema, { id: `urn:atlas:contract:${key}` });
  }
  for (const contract of eventContracts) {
    documents[contract.type] = toJsonSchema(contract.dataSchema, {
      id: contract.schemaUri,
      title: contract.description,
    });
  }
  return documents;
}
