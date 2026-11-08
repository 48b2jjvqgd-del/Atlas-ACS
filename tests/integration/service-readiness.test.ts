import { readinessResponseSchema } from '@atlas/contracts';
import { definition as acsCore } from '@atlas/acs-core/service';
import { createService } from '@atlas/service-kit';
import { describe, expect, it } from 'vitest';
import { infrastructure, withCredentials } from './env.js';

const baseEnv = { ATLAS_ENV: 'test', LOG_LEVEL: 'silent', PORT: '0' };

describe('service readiness against real infrastructure', () => {
  it('reports acs-core ready when PostgreSQL, Valkey and RabbitMQ are reachable', async () => {
    const service = await createService(acsCore, {
      ...baseEnv,
      DATABASE_URL: infrastructure.databaseUrl,
      VALKEY_URL: infrastructure.valkeyUrl,
      RABBITMQ_URL: infrastructure.rabbitmqUrl,
    });
    const address = await service.start();
    let body = readinessResponseSchema.parse(await (await fetch(`${address}/health/ready`)).json());
    for (let attempt = 0; attempt < 30 && body.status !== 'ready'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      body = readinessResponseSchema.parse(await (await fetch(`${address}/health/ready`)).json());
    }
    expect(body.status).toBe('ready');
    expect(body.checks.map((check) => `${check.name}:${check.status}`).sort()).toEqual([
      'postgres:up',
      'rabbitmq:up',
      'valkey:up',
    ]);
    await service.stop();
  });

  it('reports not ready, without leaking credentials, when a dependency rejects authentication', async () => {
    const service = await createService(acsCore, {
      ...baseEnv,
      DATABASE_URL: withCredentials(infrastructure.databaseUrl, 'wrong-password-zz9'),
      VALKEY_URL: infrastructure.valkeyUrl,
      RABBITMQ_URL: infrastructure.rabbitmqUrl,
    });
    const response = await service.app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.checks.find((check) => check.name === 'postgres')?.status).toBe('down');
    expect(response.body).not.toContain('wrong-password-zz9');
    await service.stop();
  });
});
