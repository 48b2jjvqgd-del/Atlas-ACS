import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { livenessResponseSchema } from '@atlas/contracts';
import { AtlasError } from '@atlas/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServiceClient } from './http-client.js';

let server: Server;
let baseUrl: string;
const received: Record<string, string | undefined>[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    received.push({
      correlation: request.headers['x-correlation-id'] as string | undefined,
      caller: request.headers['x-atlas-caller'] as string | undefined,
    });
    if (request.url === '/slow') return; // never responds
    if (request.url === '/needs-fresh-token') {
      const fresh = request.headers.authorization === 'Bearer token-2';
      response.writeHead(fresh ? 200 : 401, { 'content-type': 'application/json' }).end(
        fresh
          ? '{"status":"ok","service":"protocol"}'
          : JSON.stringify({
              type: 'urn:x',
              title: 't',
              status: 401,
              code: 'UNAUTHENTICATED',
              detail: 'Token signature is invalid',
              correlationId: 'abcdefgh-1',
            }),
      );
      return;
    }
    if (request.url === '/bad-contract') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"weird"}');
      return;
    }
    if (request.url === '/problem') {
      response.writeHead(503, { 'content-type': 'application/problem+json' }).end(
        JSON.stringify({
          type: 'urn:x',
          title: 't',
          status: 503,
          code: 'SERVICE_UNAVAILABLE',
          correlationId: 'abcdefgh-1',
        }),
      );
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end('{"status":"ok","service":"protocol"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('createServiceClient', () => {
  const client = () => createServiceClient({ caller: 'api-gateway', baseUrl, timeoutMs: 300 });

  it('propagates correlation ID and caller identity, and validates the response contract', async () => {
    const result = await client().get('/ok', {
      correlationId: 'corr-12345678',
      schema: livenessResponseSchema,
    });
    expect(result.body).toEqual({ status: 'ok', service: 'protocol' });
    expect(received.at(-1)).toEqual({ correlation: 'corr-12345678', caller: 'api-gateway' });
  });

  it('fails with UPSTREAM_TIMEOUT instead of waiting indefinitely', async () => {
    await expect(client().get('/slow', { correlationId: 'corr-12345678' })).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
    });
  });

  it('rejects responses that violate the contract', async () => {
    await expect(
      client().get('/bad-contract', {
        correlationId: 'corr-12345678',
        schema: livenessResponseSchema,
      }),
    ).rejects.toBeInstanceOf(AtlasError);
  });

  it('surfaces the upstream problem code without leaking upstream detail', async () => {
    await expect(
      client().get('/problem', { correlationId: 'corr-12345678' }),
    ).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'Upstream responded 503 (SERVICE_UNAVAILABLE)',
    });
  });

  it('renews a rejected service token once and retries', async () => {
    let issued = 0;
    const tokens = { token: async () => `token-${++issued}`, invalidate: () => undefined };
    const client = createServiceClient({
      caller: 'api-gateway',
      callee: 'protocol',
      baseUrl,
      timeoutMs: 500,
      tokens,
    });
    const result = await client.get('/needs-fresh-token', { correlationId: 'corr-12345678' });
    expect(result.status).toBe(200);
    expect(issued).toBe(2);
  });

  it('reports DEPENDENCY_UNAVAILABLE when nothing is listening', async () => {
    const unreachable = createServiceClient({
      caller: 'api-gateway',
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 500,
    });
    await expect(unreachable.get('/', { correlationId: 'corr-12345678' })).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
});
