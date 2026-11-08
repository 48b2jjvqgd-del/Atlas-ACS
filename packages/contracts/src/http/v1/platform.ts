import { isoTimestampSchema, z } from '@atlas/schemas';
import { successEnvelope } from '../envelope.js';
import { serviceNameSchema } from '../../services.js';
import { dependencyCheckSchema } from './health.js';

/**
 * GET /v1/platform/services  (api-gateway)
 *
 * Aggregated readiness of every registered service, as observed by the gateway. Used by the
 * portal's System Health view. Implemented in Stage 0.
 */
export const serviceStatusSchema = z.object({
  service: serviceNameSchema,
  status: z.enum(['ready', 'not_ready', 'unreachable']),
  version: z.string().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  checks: z.array(dependencyCheckSchema),
});

export const platformServicesSchema = z.object({
  checkedAt: isoTimestampSchema,
  services: z.array(serviceStatusSchema),
});

export const platformServicesResponseSchema = successEnvelope(platformServicesSchema);

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type PlatformServices = z.infer<typeof platformServicesSchema>;
