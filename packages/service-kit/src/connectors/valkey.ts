import type { Logger } from '@atlas/observability';
import { Redis } from 'ioredis';

/**
 * Valkey connector.
 *
 * Valkey (BSD-3-Clause, Linux Foundation) is the key-value store (ADR-019). It speaks the Redis
 * protocol, so the MIT-licensed ioredis client and redis:// / rediss:// URLs are used unchanged.
 *
 * Every key is namespaced with the owning service's prefix (see the service catalogue), so
 * services sharing a Valkey deployment cannot read or overwrite each other's keys by accident.
 * The offline queue is disabled: commands fail fast while disconnected rather than queueing
 * unbounded work, which keeps latency predictable on the authentication path.
 */
export interface ValkeyConnector {
  readonly client: Redis;
  check(): Promise<void>;
  close(): Promise<void>;
}

export function createValkeyConnector(options: {
  url: string;
  keyPrefix: string;
  connectionName: string;
  logger: Logger;
}): ValkeyConnector {
  const client = new Redis(options.url, {
    keyPrefix: options.keyPrefix,
    connectionName: options.connectionName,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 250, 5_000),
  });

  let lastErrorLoggedAt = 0;
  client.on('error', (error) => {
    // Reconnect attempts emit an error each time; throttle to avoid flooding logs.
    if (Date.now() - lastErrorLoggedAt > 30_000) {
      lastErrorLoggedAt = Date.now();
      options.logger.warn(
        { error: { code: (error as { code?: string }).code } },
        'Valkey connection error',
      );
    }
  });
  client.connect().catch(() => {
    /* reported via the error event and readiness; ioredis keeps retrying */
  });

  return {
    client,
    async check() {
      await client.ping();
    },
    async close() {
      client.disconnect(false);
    },
  };
}
