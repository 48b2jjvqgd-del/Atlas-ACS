import { readFileSync } from 'node:fs';

/**
 * Secret loading convention.
 *
 * A secret named FOO may be supplied either as the environment variable FOO, or as FOO_FILE
 * pointing to a file containing the value (Docker/Kubernetes secrets, Vault agent, etc.).
 * FOO_FILE takes precedence. Supplying both is rejected as ambiguous.
 *
 * This keeps services portable between local development (.env) and controlled environments
 * (mounted secrets) without code changes. Secret values are never logged or echoed in errors.
 */
export function resolveSecret(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const filePath = env[`${name}_FILE`];
  const direct = env[name];
  if (filePath && direct) {
    throw new Error(`Both ${name} and ${name}_FILE are set; supply exactly one`);
  }
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch {
      throw new Error(`Secret file for ${name} could not be read`);
    }
  }
  return direct;
}

/** Returns a copy of env with every listed secret resolved from its *_FILE variant if present. */
export function resolveSecrets(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...env };
  for (const name of names) {
    resolved[name] = resolveSecret(env, name);
    delete resolved[`${name}_FILE`];
  }
  return resolved;
}

/** Removes credentials from a connection URL so it can be logged or displayed. */
export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '***';
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '[INVALID URL]';
  }
}
