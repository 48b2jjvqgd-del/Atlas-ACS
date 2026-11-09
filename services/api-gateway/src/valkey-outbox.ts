import { hostname } from 'node:os';
import type { EventEnvelope } from '@atlas/contracts';
import type { Logger, ServiceMetrics } from '@atlas/observability';
import { injectTraceContext } from '@atlas/observability';
import type { EventPublisher } from '@atlas/service-kit';
import type { Redis } from 'ioredis';

/**
 * Durable outbox for the gateway's audit events (sign-in, sign-out, session expiry, denials).
 *
 * The gateway owns no database, so its outbox is a Valkey list (Valkey runs with an append-only
 * file). Events are queued first and relayed to RabbitMQ afterwards, so a broker outage delays
 * audit events but does not lose them. Each relay moves items atomically to its own processing
 * list (LMOVE) before publishing, so a crash mid-publish leaves the item to be retried on restart.
 * Duplicates are possible and harmless: audit-service deduplicates by event id.
 */
const QUEUE = 'outbox';

interface QueuedEvent {
  envelope: EventEnvelope;
  traceparent?: string;
}

export class ValkeyOutbox {
  readonly #processing = `outbox:processing:${hostname()}`;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #running: Promise<void> | undefined;

  constructor(
    private readonly redis: Redis,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly metrics?: ServiceMetrics,
  ) {}

  async enqueue(envelope: EventEnvelope): Promise<void> {
    const traceparent = injectTraceContext().traceparent;
    const item: QueuedEvent = { envelope, ...(traceparent ? { traceparent } : {}) };
    await this.redis.lpush(QUEUE, JSON.stringify(item));
  }

  start(intervalMs = 250): void {
    this.#stopped = false;
    const tick = () => {
      if (this.#stopped) return;
      this.#running = this.drain()
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          this.#running = undefined;
          if (!this.#stopped) {
            this.#timer = setTimeout(tick, intervalMs);
            this.#timer.unref();
          }
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /** Publishes queued events (oldest first). Stops at the first failure and retries later. */
  async drain(): Promise<number> {
    let published = 0;
    // Items left in this instance's processing list by a previous crash go first.
    for (;;) {
      const raw =
        (await this.redis.lindex(this.#processing, -1)) ??
        (await this.redis.lmove(QUEUE, this.#processing, 'RIGHT', 'LEFT'));
      if (!raw) return published;
      try {
        const item = JSON.parse(raw) as QueuedEvent;
        await this.publisher.publishEnvelope(
          item.envelope,
          item.traceparent ? { traceparent: item.traceparent } : {},
        );
        await this.redis.lrem(this.#processing, 1, raw);
        this.metrics?.outboxRelayed.inc({ outcome: 'published' });
        published += 1;
      } catch (error) {
        if (error instanceof SyntaxError) {
          // Corrupt entry: drop it rather than block the queue, and say so.
          await this.redis.lrem(this.#processing, 1, raw);
          this.logger.error('discarded unreadable outbox entry');
          continue;
        }
        this.metrics?.outboxRelayed.inc({ outcome: 'failed' });
        this.logger.warn(
          { error: { name: (error as Error).name } },
          'audit event publish failed; will retry',
        );
        return published;
      }
    }
  }

  async pending(): Promise<number> {
    const [queued, processing] = await Promise.all([
      this.redis.llen(QUEUE),
      this.redis.llen(this.#processing),
    ]);
    return queued + processing;
  }
}
