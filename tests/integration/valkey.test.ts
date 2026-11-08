import { createLogger } from '@atlas/observability';
import { createValkeyConnector } from '@atlas/service-kit';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { infrastructure, withCredentials } from './env.js';

const logger = createLogger({
  service: 'integration',
  version: '0.0.0',
  environment: 'test',
  level: 'silent',
});

async function eventually(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe('Valkey connectivity', () => {
  it('passes the readiness check once connected', async () => {
    const connector = createValkeyConnector({
      url: infrastructure.valkeyUrl,
      keyPrefix: 'atlas:integration:',
      connectionName: 'integration',
      logger,
    });
    await eventually(() => connector.check());
    await connector.close();
  });

  it('namespaces every key with the owning service prefix', async () => {
    const connector = createValkeyConnector({
      url: infrastructure.valkeyUrl,
      keyPrefix: 'atlas:acs-core:',
      connectionName: 'integration',
      logger,
    });
    await eventually(() => connector.check());
    await connector.client.set('it:probe', 'value', 'EX', 30);

    const raw = new Redis(infrastructure.valkeyUrl);
    expect(await raw.get('atlas:acs-core:it:probe')).toBe('value');
    expect(await raw.get('it:probe')).toBeNull();
    await raw.del('atlas:acs-core:it:probe');
    raw.disconnect();
    await connector.close();
  });

  it('fails fast rather than queueing commands when authentication fails', async () => {
    const connector = createValkeyConnector({
      url: withCredentials(infrastructure.valkeyUrl, 'wrong-password'),
      keyPrefix: 'atlas:integration:',
      connectionName: 'integration',
      logger,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(connector.check()).rejects.toThrow();
    await connector.close();
  });
});
