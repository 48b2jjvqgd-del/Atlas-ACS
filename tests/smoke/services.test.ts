import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  livenessResponseSchema,
  serviceInfoSchema,
  serviceNames,
  type ServiceName,
} from '@atlas/contracts';
import { describe, expect, it } from 'vitest';

/**
 * Smoke tests run the *built* output (services/<name>/dist/index.js) — the same artefact the
 * container images ship — as a real OS process. No infrastructure is required: dependency URLs
 * point at closed ports, so services must start, be live, report not-ready, and still shut down
 * cleanly. Run `pnpm build` first.
 */
const repositoryRoot = join(import.meta.dirname, '..', '..');
const unreachableInfrastructure = {
  DATABASE_URL: 'postgres://atlas:smoke@127.0.0.1:1/atlas',
  VALKEY_URL: 'redis://:smoke@127.0.0.1:1/0',
  RABBITMQ_URL: 'amqp://atlas:smoke@127.0.0.1:1',
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function launch(service: ServiceName, env: Record<string, string>) {
  const entry = join(repositoryRoot, 'services', service, 'dist', 'index.js');
  if (!existsSync(entry))
    throw new Error(`${entry} not found — run "pnpm build" before the smoke tests`);
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '', ATLAS_ENV: 'test', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  const exited = new Promise<ProcessResult>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr })),
  );
  return { child, exited, output: () => stdout };
}

async function waitForLive(url: string, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} did not become live within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.each(serviceNames)('%s process', (service) => {
  it('starts, serves health and metadata, and shuts down gracefully on SIGTERM', async () => {
    const port = await freePort();
    const { child, exited, output } = launch(service, {
      PORT: String(port),
      ...unreachableInfrastructure,
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const live = livenessResponseSchema.parse(
        await (await waitForLive(`${base}/health/live`)).json(),
      );
      expect(live.service).toBe(service);

      const info = serviceInfoSchema.parse(await (await fetch(`${base}/info`)).json());
      expect(info).toMatchObject({ service, environment: 'test' });

      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toContain(`service="${service}"`);

      child.kill('SIGTERM');
      const result = await exited;
      expect(result.code).toBe(0);
      const lines = output()
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { message?: string; service?: string });
      expect(lines.every((line) => line.service === service)).toBe(true);
      expect(lines.map((line) => line.message)).toEqual(
        expect.arrayContaining(['service started', 'shutdown requested', 'service stopped']),
      );
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

describe('invalid configuration', () => {
  it('refuses to start, exits non-zero and names the key without echoing the value', async () => {
    const { exited } = launch('acs-core', {
      PORT: 'not-a-port',
      DATABASE_URL: 'http://atlas:LeakyPassword42@db/atlas',
      VALKEY_URL: unreachableInfrastructure.VALKEY_URL,
    });
    const result = await exited;
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stderr.trim()) as { level: string; issues: { key: string }[] };
    expect(report.level).toBe('fatal');
    expect(report.issues.map((issue) => issue.key).sort()).toEqual([
      'DATABASE_URL',
      'PORT',
      'RABBITMQ_URL',
    ]);
    expect(result.stderr + result.stdout).not.toContain('LeakyPassword42');
    expect(result.stderr + result.stdout).not.toContain('not-a-port');
  });
});
