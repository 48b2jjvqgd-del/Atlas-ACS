import type { DependencyCheck } from '@atlas/contracts';

export type ReadinessCheck = () => Promise<void>;

/**
 * Readiness checks registered by the service foundation (one per declared dependency) and by
 * service code. Each check resolves when healthy and rejects otherwise; checks run in parallel
 * with a timeout so a hung dependency cannot hang the probe.
 */
export class ReadinessRegistry {
  readonly #checks = new Map<string, ReadinessCheck>();
  #shuttingDown = false;

  register(name: string, check: ReadinessCheck): void {
    if (this.#checks.has(name)) throw new Error(`Readiness check "${name}" already registered`);
    this.#checks.set(name, check);
  }

  markShuttingDown(): void {
    this.#shuttingDown = true;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  async run(timeoutMs: number): Promise<{ ready: boolean; checks: DependencyCheck[] }> {
    if (this.#shuttingDown) {
      return {
        ready: false,
        checks: [{ name: 'lifecycle', status: 'down', latencyMs: 0, error: 'shutting down' }],
      };
    }
    const checks = await Promise.all(
      [...this.#checks].map(([name, check]) => runCheck(name, check, timeoutMs)),
    );
    return { ready: checks.every((check) => check.status === 'up'), checks };
  }
}

async function runCheck(
  name: string,
  check: ReadinessCheck,
  timeoutMs: number,
): Promise<DependencyCheck> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeoutError()), timeoutMs);
      }),
    ]);
    return { name, status: 'up', latencyMs: elapsed(started) };
  } catch (error) {
    return { name, status: 'down', latencyMs: elapsed(started), error: safeFailureReason(error) };
  } finally {
    clearTimeout(timer);
  }
}

class CheckTimeoutError extends Error {}

const elapsed = (started: number) => Math.round((performance.now() - started) * 100) / 100;

/**
 * Reduces a failure to a non-sensitive reason. Driver error messages can include hostnames,
 * usernames or fragments of connection strings, so only well-known error codes are surfaced.
 */
export function safeFailureReason(error: unknown): string {
  if (error instanceof CheckTimeoutError) return 'timeout';
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) return code;
  return 'check failed';
}
