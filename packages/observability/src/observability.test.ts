import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, createServiceMetrics, startTracing } from './index.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(String(chunk)));
      callback();
    },
  });
  const logger = createLogger(
    { service: 'acs-core', version: '0.1.0', environment: 'test', level: 'info' },
    destination,
  );
  return { logger, lines };
}

describe('createLogger', () => {
  it('emits JSON lines with service metadata and ISO timestamps', () => {
    const { logger, lines } = captureLogger();
    logger.info({ tenantId: 'abc' }, 'started');
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'acs-core',
      version: '0.1.0',
      environment: 'test',
      message: 'started',
      tenantId: 'abc',
    });
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never writes secrets or card numbers, in fields or in the message', () => {
    const { logger, lines } = captureLogger();
    logger.warn(
      {
        password: 'hunter2',
        request: { acctNumber: '4111111111111111', headers: { authorization: 'Bearer abc.def' } },
      },
      'lookup failed for 4111111111111111',
    );
    const output = JSON.stringify(lines);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('4111111111111111');
    expect(output).not.toContain('abc.def');
    expect(output).toContain('411111******1111');
  });

  it('respects the configured level', () => {
    const { logger, lines } = captureLogger();
    logger.debug('hidden');
    expect(lines).toHaveLength(0);
  });
});

describe('createServiceMetrics', () => {
  it('labels all metrics with the service and exposes the HTTP histogram', async () => {
    const { registry, httpRequestDuration } = createServiceMetrics('protocol');
    httpRequestDuration.observe(
      { method: 'GET', route: '/health/live', status_code: '200' },
      0.002,
    );
    const text = await registry.metrics();
    expect(text).toContain('atlas_http_request_duration_seconds_bucket');
    const bucketLine = text.split('\n').find((line) => line.includes('route="/health/live"'));
    expect(bucketLine).toContain('service="protocol"');
    expect(bucketLine).toContain('status_code="200"');
    expect(text).toContain('atlas_process_cpu_seconds_total');
  });

  it('creates isolated registries per service instance', async () => {
    const first = createServiceMetrics('acs-core');
    const second = createServiceMetrics('acs-core');
    first.httpRequestDuration.observe({ method: 'GET', route: '/x', status_code: '200' }, 1);
    expect(await second.registry.metrics()).not.toContain('route="/x"');
  });
});

describe('startTracing', () => {
  it('is disabled unless an OTLP endpoint is configured', () => {
    expect(
      startTracing({
        service: 'acs-core',
        version: '0.1.0',
        environment: 'test',
        otlpEndpoint: undefined,
      }),
    ).toBeUndefined();
  });
});
