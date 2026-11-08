import { serviceCatalog, readinessResponseSchema } from '@atlas/contracts';
import { createService, type RunningService } from '@atlas/service-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { definition } from './service.js';

// Unreachable endpoints: proves the service starts and reports health without infrastructure.
const env = {
  ATLAS_ENV: 'test',
  LOG_LEVEL: 'silent',
  PORT: '0',
  READINESS_CHECK_TIMEOUT_MS: '1500',
  DATABASE_URL: 'postgres://atlas:test@127.0.0.1:1/atlas',
};

let service: RunningService<Record<never, never>> | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
});

describe('compliance-engine', () => {
  it('starts on a real socket and reports liveness and metadata', async () => {
    service = await createService(definition, env);
    const address = await service.start();
    const live = await fetch(`${address}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', service: 'compliance-engine' });
    const info = await (await fetch(`${address}/info`)).json();
    expect(info).toMatchObject({ service: 'compliance-engine', version: definition.version });
  });

  it('declares only the infrastructure its catalogue entry allows it to own', () => {
    const { dataStores } = serviceCatalog['compliance-engine'];
    expect(definition.dependencies.includes('postgres')).toBe(dataStores.postgresSchema !== null);
    if (definition.dependencies.includes('valkey')) expect(dataStores.valkeyPrefix).not.toBeNull();
  });

  it('reports readiness for each declared dependency', async () => {
    service = await createService(definition, env);
    const response = await service.app.inject({ method: 'GET', url: '/health/ready' });
    const body = readinessResponseSchema.parse(response.json());
    expect(body.checks.map((check) => check.name).sort()).toEqual(['postgres']);
    expect(response.statusCode).toBe(503);
  });

  it('refuses to start with invalid configuration', async () => {
    await expect(createService(definition, { ...env, PORT: 'eighty' })).rejects.toThrow(/PORT/);
  });
});
