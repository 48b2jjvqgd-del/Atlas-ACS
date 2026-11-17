import { hostname } from 'node:os';
import type { EventEnvelope } from '@atlas/contracts';
import type { Logger, ServiceMetrics } from '@atlas/observability';
import { injectTraceContext } from '@atlas/observability';
import { POISON_ATTEMPTS, type EventPublisher } from '@atlas/service-kit';
import type { Redis } from 'ioredis';

/**
 * Durable outbox for the gateway's audit events (sign-in, sign-out, session expiry, denials).
 *
 * The gateway owns no database, so its outbox is a Valkey list (Valkey runs with an append-only
 * file). Events are queued first and relayed to RabbitMQ afterwards, so a broker outage delays
 * audit events but does not lose them. Each relay moves items atomically to its own processing
 * list (LMOVE) before publishing, so a crash mid-publish leaves the item to be retried on restart.
 * Duplicates are possible and harmless: audit-service deduplicates by event id.
 *
 * Ordering is best effort, as for the PostgreSQL outbox (ADR-037): one instance relays oldest
 * first and stops at the first failure, so a broker outage does not reorder events; several
 * gateway instances relay concurrently, and a poison item is overtaken.
 *
 * Poison items, handled like the PostgreSQL relay: after POISON_ATTEMPTS consecutive failures the
 * head item is moved to `outbox:set-aside` and the next item is tried. If that one publishes, the
 * suspect stays set aside (logged at error level, metric outcome "set-aside") and is re-queued
 * every `setAsideRetryMs`; if it fails too, the broker is the problem and the suspect goes back to
 * the head. An unreadable entry is moved to `outbox:unreadable`. Nothing is ever deleted unpublished.
 */
const QUEUE = 'outbox';
const SET_ASIDE = 'outbox:set-aside';
const UNREADABLE = 'outbox:unreadable';

interface QueuedEvent {
  envelope: EventEnvelope;
  traceparent?: string;
}

export interface ValkeyOutboxOptions {
  /** How often set-aside items are re-queued for another attempt. */
  setAsideRetryMs?: number;
}

export class ValkeyOutbox {
  readonly #processing = `outbox:processing:${hostname()}`;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #running: Promise<void> | undefined;
  #head: { raw: string; failures: number } | undefined;
  #lastSetAsideRetry = Date.now();

  constructor(
    private readonly redis: Redis,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly metrics?: ServiceMetrics,
    private readonly options: ValkeyOutboxOptions = {},
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
    await this.requeueSetAside();
    let published = 0;
    let suspect: string | undefined;
    // Items left in this instance's processing list by a previous crash go first.
    for (;;) {
      const raw =
        (await this.redis.lindex(this.#processing, -1)) ??
        (await this.redis.lmove(QUEUE, this.#processing, 'RIGHT', 'LEFT'));
      if (!raw) {
        // Nothing behind the suspect, so it blocks nothing: back to the head to keep retrying.
        if (suspect) await this.restoreSuspect(suspect);
        return published;
      }
      let item: QueuedEvent;
      try {
        item = JSON.parse(raw) as QueuedEvent;
      } catch {
        // Cannot be published as it is; kept for investigation rather than dropped.
        await this.redis.lmove(this.#processing, UNREADABLE, 'RIGHT', 'LEFT');
        this.metrics?.outboxRelayed.inc({ outcome: 'set-aside' });
        this.logger.error({ list: UNREADABLE }, 'unreadable outbox entry set aside');
        continue;
      }
      try {
        await this.publisher.publishEnvelope(
          item.envelope,
          item.traceparent ? { traceparent: item.traceparent } : {},
        );
        await this.redis.lrem(this.#processing, 1, raw);
        this.#head = undefined;
        this.metrics?.outboxRelayed.inc({ outcome: 'published' });
        published += 1;
        if (suspect) {
          // The broker accepted the item behind the suspect: the suspect itself is the problem.
          this.metrics?.outboxRelayed.inc({ outcome: 'set-aside' });
          this.logger.error(
            { eventId: eventIdOf(suspect), list: SET_ASIDE },
            'outbox item set aside: it keeps failing while later items publish; needs investigation',
          );
          suspect = undefined;
        }
      } catch (error) {
        const failures = (this.#head?.raw === raw ? this.#head.failures : 0) + 1;
        this.#head = { raw, failures };
        this.metrics?.outboxRelayed.inc({ outcome: 'failed' });
        this.logger.warn(
          { eventId: item.envelope?.id, failures, error: { name: (error as Error).name } },
          'audit event publish failed; will retry',
        );
        if (!suspect && failures >= POISON_ATTEMPTS) {
          // Probe with the next item: is it this item, or the broker?
          await this.redis.lmove(this.#processing, SET_ASIDE, 'RIGHT', 'LEFT');
          this.#head = undefined;
          suspect = raw;
          continue;
        }
        if (suspect) await this.restoreSuspect(suspect);
        return published;
      }
    }
  }

  /** Puts a suspect back at the head of this instance's processing list (oldest position). */
  private async restoreSuspect(raw: string): Promise<void> {
    // Only if it is still set aside: another instance may already have re-queued it.
    if ((await this.redis.lrem(SET_ASIDE, 1, raw)) > 0) {
      await this.redis.rpush(this.#processing, raw);
    }
  }

  private async requeueSetAside(): Promise<void> {
    const interval = this.options.setAsideRetryMs ?? 5 * 60_000;
    if (Date.now() - this.#lastSetAsideRetry < interval) return;
    this.#lastSetAsideRetry = Date.now();
    // Oldest end of the queue: set-aside items are the next to be tried.
    while (await this.redis.lmove(SET_ASIDE, QUEUE, 'RIGHT', 'RIGHT')) {
      /* moved one */
    }
  }

  /** Items not yet published, including set-aside ones (not unreadable entries). */
  async pending(): Promise<number> {
    const [queued, processing, setAside] = await Promise.all([
      this.redis.llen(QUEUE),
      this.redis.llen(this.#processing),
      this.redis.llen(SET_ASIDE),
    ]);
    return queued + processing + setAside;
  }

  async setAside(): Promise<number> {
    return this.redis.llen(SET_ASIDE);
  }
}

function eventIdOf(raw: string): string | undefined {
  try {
    return (JSON.parse(raw) as QueuedEvent).envelope.id;
  } catch {
    return undefined;
  }
}
