import { defineService, readPackageVersion } from '@atlas/service-kit';

/**
 * Reporting Service — Stage 0 skeleton.
 *
 * Exposes only the standard infrastructure endpoints. Domain routes are added in later stages
 * under the /v1 prefix; see README.md for this service's boundaries.
 */
export const definition = defineService({
  name: 'reporting-service',
  version: readPackageVersion(import.meta.url),
  dependencies: ['postgres', 'rabbitmq'],
});
