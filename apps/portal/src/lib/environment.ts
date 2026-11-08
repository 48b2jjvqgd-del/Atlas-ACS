import { atlasEnvironments, type AtlasEnvironment } from '@atlas/shared';

/**
 * Build-time environment label. Defaults to development; the portal never infers that it is in
 * production. Scheme connectivity is always simulated in Stage 0.
 */
const configured = import.meta.env.VITE_ATLAS_ENV as string | undefined;

export const portalEnvironment: AtlasEnvironment = (
  atlasEnvironments as readonly string[]
).includes(configured ?? '')
  ? (configured as AtlasEnvironment)
  : 'development';

export const schemeConnectivity = 'simulation' as const;
