/**
 * Deployment environments recognised by ATLAS.
 *
 * - development: a developer workstation.
 * - test:        automated test runs.
 * - simulation:  a running stack wired to the ATLAS simulator instead of real schemes.
 * - staging / production: reserved for future controlled environments. Stage 0 makes no
 *   claim that any part of ATLAS is fit for production use.
 */
export const atlasEnvironments = [
  'development',
  'test',
  'simulation',
  'staging',
  'production',
] as const;

export type AtlasEnvironment = (typeof atlasEnvironments)[number];

/** Environments in which synthetic seed data and developer conveniences are permitted. */
export const syntheticDataEnvironments: readonly AtlasEnvironment[] = [
  'development',
  'test',
  'simulation',
];

export function allowsSyntheticData(environment: AtlasEnvironment): boolean {
  return syntheticDataEnvironments.includes(environment);
}
