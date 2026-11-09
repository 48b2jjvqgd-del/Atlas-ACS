import { principalResponseSchema, type Principal } from '@atlas/contracts';
import type { ServiceClient } from '../http-client.js';
import type { PrincipalResolver } from './access.js';

/**
 * Resolves principals by asking identity-service (the system of record for users, roles and
 * memberships), authenticated with this service's own service token.
 *
 * Results are cached briefly per subject so a page of portal requests costs one lookup. The TTL
 * bounds how long a revoked permission can still be used: 10 seconds by default. Disabling a user
 * additionally ends their sessions at the identity provider, and the gateway refuses new requests.
 */
export function createRemotePrincipalResolver(options: {
  identityService: ServiceClient;
  ttlMs?: number;
  maxEntries?: number;
}): PrincipalResolver & { invalidate(subject?: string): void } {
  const ttl = options.ttlMs ?? 10_000;
  const max = options.maxEntries ?? 1_000;
  const cache = new Map<string, { value: Principal | null; expiresAt: number }>();

  return {
    async resolve(subject, context) {
      const hit = cache.get(subject);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const response = await options.identityService.get(
        `/v1/internal/principals/${encodeURIComponent(subject)}`,
        {
          correlationId: context.correlationId,
          schema: principalResponseSchema,
          acceptStatus: (status) => status === 200 || status === 404,
        },
      );
      const value = response.status === 404 ? null : response.body.data;
      if (cache.size >= max) cache.delete(cache.keys().next().value as string);
      cache.set(subject, { value, expiresAt: Date.now() + ttl });
      return value;
    },
    invalidate(subject) {
      if (subject) cache.delete(subject);
      else cache.clear();
    },
  };
}
