import { defineService, readPackageVersion } from '@atlas/service-kit';

/**
 * Fraud Engine — Stage 0 skeleton.
 *
 * Exposes only the standard infrastructure endpoints. Domain routes are added in later stages
 * under the /v1 prefix; see README.md for this service's boundaries.
 */
export const definition = defineService({
  name: 'fraud-engine',
  version: readPackageVersion(import.meta.url),
  dependencies: ['postgres'],
});
