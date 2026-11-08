import { isoTimestampSchema, semverSchema, z } from '@atlas/schemas';
import { atlasEnvironments } from '@atlas/shared';
import { serviceNameSchema } from '../../services.js';

/**
 * Infrastructure endpoints exposed by every service. These are deliberately unversioned
 * paths (/health/live, /health/ready, /info, /metrics) because orchestrators and monitoring
 * tools depend on them being stable; their payloads are versioned through these schemas.
 */

export const dependencyStatusSchema = z.enum(['up', 'down']);

export const dependencyCheckSchema = z.object({
  name: z.string(),
  status: dependencyStatusSchema,
  latencyMs: z.number().nonnegative(),
  /** Safe, generic failure description. Never includes connection strings or credentials. */
  error: z.string().optional(),
});

export const livenessResponseSchema = z.object({
  status: z.literal('ok'),
  service: serviceNameSchema,
});

export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: serviceNameSchema,
  checks: z.array(dependencyCheckSchema),
});

export const serviceInfoSchema = z.object({
  service: serviceNameSchema,
  version: semverSchema,
  environment: z.enum(atlasEnvironments),
  apiVersions: z.array(z.string()),
  build: z.object({ sha: z.string().nullable() }),
  startedAt: isoTimestampSchema,
  uptimeSeconds: z.number().nonnegative(),
});

export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type ServiceInfo = z.infer<typeof serviceInfoSchema>;
