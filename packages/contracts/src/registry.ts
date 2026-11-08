import { toJsonSchema, type z } from '@atlas/schemas';
import { eventEnvelopeSchema, type EventContract } from './events/envelope.js';
import { configurationChangedV1 } from './events/v1/platform.js';
import { tenantCreatedV1 } from './events/v1/issuer.js';
import { problemDetailsSchema } from './http/problem.js';
import {
  livenessResponseSchema,
  readinessResponseSchema,
  serviceInfoSchema,
} from './http/v1/health.js';
import { getTenantResponseSchema } from './http/v1/issuer.js';
import { platformServicesResponseSchema } from './http/v1/platform.js';

/** Every published event contract. Adding a contract here publishes its JSON Schema. */
export const eventContracts: readonly EventContract[] = [tenantCreatedV1, configurationChangedV1];

/** Every published HTTP schema, keyed by a stable contract identifier. */
export const httpSchemas: Readonly<Record<string, z.ZodType>> = {
  'http.problem-details': problemDetailsSchema,
  'http.v1.liveness-response': livenessResponseSchema,
  'http.v1.readiness-response': readinessResponseSchema,
  'http.v1.service-info': serviceInfoSchema,
  'http.v1.platform-services-response': platformServicesResponseSchema,
  'http.v1.get-tenant-response': getTenantResponseSchema,
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
