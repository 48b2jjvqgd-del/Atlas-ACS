import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@atlas/schemas';
import { ConfigurationError } from '@atlas/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { loadServiceConfig } from './config.js';

function configError(fn: () => unknown): ConfigurationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error('expected ConfigurationError');
}

describe('loadServiceConfig', () => {
  it('applies safe defaults, including the catalogue port and loopback binding', () => {
    const config = loadServiceConfig('protocol', [], {}, {});
    expect(config).toMatchObject({
      ATLAS_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 4002,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
    });
  });

  it('requires connection URLs only for declared dependencies', () => {
    expect(() => loadServiceConfig('protocol', [], {}, {})).not.toThrow();
    const error = configError(() =>
      loadServiceConfig('acs-core', ['postgres', 'valkey', 'rabbitmq'], {}, {}),
    );
    expect(error.issues.map((issue) => issue.key).sort()).toEqual([
      'DATABASE_URL',
      'RABBITMQ_URL',
      'VALKEY_URL',
    ]);
    expect(error.issues[0]?.message).toBe('is required');
  });

  it('names invalid keys without echoing their values', () => {
    const error = configError(() =>
      loadServiceConfig(
        'acs-core',
        ['postgres'],
        {},
        {
          PORT: 'not-a-port-9f8e7d',
          ATLAS_ENV: 'prod-typo-1a2b3c',
          DATABASE_URL: 'http://atlas:SuperSecretPassword123@db:5432/atlas',
        },
      ),
    );
    const keys = error.issues.map((issue) => issue.key).sort();
    expect(keys).toEqual(['ATLAS_ENV', 'DATABASE_URL', 'PORT']);
    const rendered = `${error.message} ${JSON.stringify(error.issues)}`;
    expect(rendered).not.toContain('SuperSecretPassword123');
    expect(rendered).not.toContain('not-a-port-9f8e7d');
    expect(rendered).not.toContain('prod-typo-1a2b3c');
  });

  it('treats empty strings as unset', () => {
    const config = loadServiceConfig('protocol', [], {}, { PORT: '', LOG_LEVEL: '' });
    expect(config.PORT).toBe(4002);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('rejects invalid booleans rather than guessing', () => {
    const error = configError(() => loadServiceConfig('protocol', [], {}, { LOG_PRETTY: 'yes' }));
    expect(error.issues[0]?.key).toBe('LOG_PRETTY');
  });

  it('validates service-specific configuration', () => {
    const shape = { FEATURE_LIMIT: z.coerce.number().int().max(10) };
    expect(loadServiceConfig('protocol', [], shape, { FEATURE_LIMIT: '5' }).FEATURE_LIMIT).toBe(5);
    expect(
      configError(() => loadServiceConfig('protocol', [], shape, { FEATURE_LIMIT: '50' })).issues[0]
        ?.key,
    ).toBe('FEATURE_LIMIT');
  });

  describe('secret files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-config-'));
    afterAll(() => rmSync(directory, { recursive: true, force: true }));

    it('reads connection URLs from *_FILE variables', () => {
      const file = join(directory, 'database-url');
      writeFileSync(file, 'postgres://atlas:pw@localhost:5432/atlas\n');
      const config = loadServiceConfig(
        'issuer-service',
        ['postgres'],
        {},
        { DATABASE_URL_FILE: file },
      );
      expect(config.DATABASE_URL).toBe('postgres://atlas:pw@localhost:5432/atlas');
    });

    it('reports an unreadable secret file as a configuration error', () => {
      const error = configError(() =>
        loadServiceConfig(
          'issuer-service',
          ['postgres'],
          {},
          { DATABASE_URL_FILE: join(directory, 'missing') },
        ),
      );
      expect(error.issues[0]?.key).toBe('DATABASE_URL');
    });
  });
});
