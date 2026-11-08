import { Writable } from 'node:stream';
import { problemDetailsSchema, readinessResponseSchema, serviceInfoSchema } from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import { z } from '@atlas/schemas';
import { AtlasError } from '@atlas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createService, type RunningService } from './runtime.js';
import { defineService } from './service.js';

const logLines: string[] = [];
const logger = createLogger(
  { service: 'acs-core', version: '0.1.0', environment: 'test', level: 'debug' },
  new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk));
      callback();
    },
  }),
);

const testDefinition = defineService({
  name: 'acs-core',
  version: '0.1.0',
  dependencies: [],
  register(app, context) {
    app.post(
      '/v1/echo',
      { schema: { body: z.object({ slug: z.string().min(3) }) } },
      async (request) => ({
        data: request.body,
        meta: { correlationId: request.correlationId, apiVersion: 'v1' },
      }),
    );
    app.get('/v1/conflict', async () => {
      throw new AtlasError('CONFLICT', { detail: 'Tenant slug already exists' });
    });
    app.get('/v1/boom', async () => {
      throw new Error('db password is hunter2 at 10.1.2.3');
    });
    app.get('/v1/correlation', async (request) => ({ correlationId: request.correlationId }));
    if (process.env.TEST_FAILING_CHECK === '1') {
      context.readiness.register('downstream', async () => {
        throw Object.assign(new Error('connect ECONNREFUSED atlas:secret@10.0.0.1'), {
          code: 'ECONNREFUSED',
        });
      });
    }
  },
});

let service: RunningService<Record<never, never>> | undefined;
async function start(env: Record<string, string> = {}) {
  service = await createService(testDefinition, { ATLAS_ENV: 'test', ...env }, { logger });
  return service.app;
}

afterEach(async () => {
  delete process.env.TEST_FAILING_CHECK;
  await service?.stop();
  service = undefined;
  logLines.length = 0;
});

describe('infrastructure endpoints', () => {
  it('reports liveness', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'acs-core' });
  });

  it('reports ready when every check passes', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(response.json()).status).toBe('ready');
  });

  it('reports not ready with a sanitised reason when a dependency fails', async () => {
    process.env.TEST_FAILING_CHECK = '1';
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = readinessResponseSchema.parse(response.json());
    expect(body.checks).toEqual([
      expect.objectContaining({ name: 'downstream', status: 'down', error: 'ECONNREFUSED' }),
    ]);
    expect(response.body).not.toContain('secret');
  });

  it('reports not ready once shutdown has begun', async () => {
    const app = await start();
    service?.context.readiness.markShuttingDown();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
  });

  it('exposes service metadata conforming to the contract', async () => {
    const app = await start({ ATLAS_BUILD_SHA: 'abc1234' });
    const info = serviceInfoSchema.parse(
      (await app.inject({ method: 'GET', url: '/info' })).json(),
    );
    expect(info).toMatchObject({
      service: 'acs-core',
      environment: 'test',
      build: { sha: 'abc1234' },
    });
  });

  it('exposes Prometheus metrics including request durations by route template', async () => {
    const app = await start();
    await app.inject({ method: 'GET', url: '/v1/correlation' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toMatch(
      /atlas_http_request_duration_seconds_count\{[^}]*route="\/v1\/correlation"/,
    );
  });
});

describe('correlation IDs', () => {
  it('propagates a well-formed upstream correlation ID', async () => {
    const app = await start();
    const id = 'upstream-1234-abcd';
    const response = await app.inject({
      method: 'GET',
      url: '/v1/correlation',
      headers: { 'x-correlation-id': id },
    });
    expect(response.json()).toEqual({ correlationId: id });
    expect(response.headers['x-correlation-id']).toBe(id);
    expect(logLines.some((line) => line.includes(`"correlationId":"${id}"`))).toBe(true);
  });

  it('replaces a malformed correlation ID instead of echoing it', async () => {
    const app = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/correlation',
      headers: { 'x-correlation-id': '<script>alert(1)</script>' },
    });
    const { correlationId } = response.json<{ correlationId: string }>();
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-correlation-id']).toBe(correlationId);
  });

  it('always generates a fresh request ID, ignoring client-supplied ones', async () => {
    const app = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'spoofed' },
    });
    expect(response.headers['x-request-id']).not.toBe('spoofed');
  });
});

describe('error responses', () => {
  const expectProblem = (body: unknown) => problemDetailsSchema.parse(body);

  it('returns RFC 9457 problem details for unknown routes', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/nope?x=1' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(expectProblem(response.json())).toMatchObject({
      code: 'NOT_FOUND',
      instance: '/v1/nope',
    });
  });

  it('returns field-level issues for Zod validation failures', async () => {
    const app = await start();
    const response = await app.inject({ method: 'POST', url: '/v1/echo', payload: { slug: 'x' } });
    expect(response.statusCode).toBe(400);
    const problem = expectProblem(response.json());
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.issues?.[0]?.path).toBe('body.slug');
  });

  it('accepts valid input', async () => {
    const app = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: { slug: 'demo' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { slug: 'demo' } });
  });

  it('maps malformed JSON to BAD_REQUEST', async () => {
    const app = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: '{"slug":',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(400);
    expect(expectProblem(response.json()).code).toBe('BAD_REQUEST');
  });

  it('rejects oversized bodies', async () => {
    const app = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/echo',
      payload: { slug: 'x'.repeat(300 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    expect(expectProblem(response.json()).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('exposes the detail of deliberate AtlasErrors', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/conflict' });
    expect(response.statusCode).toBe(409);
    expect(expectProblem(response.json())).toMatchObject({
      code: 'CONFLICT',
      detail: 'Tenant slug already exists',
    });
  });

  it('hides internals of unexpected errors from clients and redacts them in logs', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/v1/boom' });
    expect(response.statusCode).toBe(500);
    expect(expectProblem(response.json()).code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('10.1.2.3');
    expect(logLines.some((line) => line.includes('"level":"error"'))).toBe(true);
  });
});

describe('secure defaults', () => {
  it('sets restrictive security headers on API responses', async () => {
    const app = await start();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
