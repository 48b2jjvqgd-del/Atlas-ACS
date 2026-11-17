import type { EventEnvelope } from '@atlas/contracts';
import type { Logger, ServiceMetrics } from '@atlas/observability';
import { injectTraceContext } from '@atlas/observability';
import pg from 'pg';
import type { EventPublisher } from '../messaging.js';
import type { Queryable } from './scope.js';

/**
 * Transactional outbox (Stage 1A).
 *
 * `enqueueEvent` inserts an event into <schema>.outbox *inside the caller's transaction*, so the
 * event exists if and only if the change it describes committed. `OutboxRelay` then publishes
 * pending rows to RabbitMQ (confirmed publishes) and marks them published. If RabbitMQ is down,
 * rows wait and are retried with back-off; nothing is lost.
 *
 * Guarantees (asserted by tests/integration/outbox-resilience.test.ts and outbox-ordering.test.ts):
 *   - No loss: a committed event stays in the outbox until the broker has confirmed it.
 *   - At-least-once: a relay that stops between the broker's confirm and its own commit publishes
 *     the row again, so consumers deduplicate by event id.
 *   - No double publish by concurrent relays: rows are claimed with FOR UPDATE SKIP LOCKED.
 *   - Poison rows cannot block the outbox: see `relayBatch`.
 *
 * Ordering is best effort, NOT guaranteed, and no ATLAS consumer depends on it (ADR-037):
 *   - One relay publishes the rows it can see in insertion order (relay_sequence), so events of one
 *     transaction leave in the order they were written, and a broker outage does not reorder them.
 *   - Commit order is not preserved: a transaction that started earlier can commit, and be relayed,
 *     after a later one. Several relay instances publish disjoint batches concurrently, a poison row
 *     is overtaken by the rows behind it, and consumers process messages concurrently and retry
 *     failures later. Consumers must therefore be idempotent and order-independent.
 *
 * The trace context active at enqueue time is stored with the row, so the published event
 * continues the trace of the request that caused it.
 */
export async function enqueueEvent(
  client: Queryable,
  schema: string,
  envelope: EventEnvelope,
): Promise<void> {
  await client.query(
    `INSERT INTO ${pg.escapeIdentifier(schema)}.outbox (id, event_type, envelope, traceparent)
     VALUES ($1, $2, $3, $4)`,
    [
      envelope.id,
      envelope.type,
      JSON.stringify(envelope),
      injectTraceContext().traceparent ?? null,
    ],
  );
}

export interface OutboxRelayOptions {
  pool: pg.Pool;
  schema: string;
  publisher: EventPublisher;
  logger: Logger;
  metrics?: ServiceMetrics;
  intervalMs?: number;
  batchSize?: number;
  /** Published rows older than this are deleted. */
  retentionMs?: number;
}

/**
 * After this many failed attempts a row is suspected of being poison. It is set aside (given its
 * own back-off) only if a row behind it then publishes, i.e. the broker is accepting messages and
 * the failure belongs to that row. While the broker is down no row is set aside.
 */
export const POISON_ATTEMPTS = 5;
const MAX_RELAY_BACKOFF_MS = 30_000;

export class OutboxRelay {
  #timer: NodeJS.Timeout | undefined;
  #failures = 0;
  #running: Promise<void> | undefined;
  #stopped = false;
  #lastCleanup = 0;
  readonly #table: string;

  constructor(private readonly options: OutboxRelayOptions) {
    this.#table = `${pg.escapeIdentifier(options.schema)}.outbox`;
  }

  start(): void {
    this.#stopped = false;
    const tick = () => {
      if (this.#stopped) return;
      this.#running = this.drain()
        .then(() => undefined)
        .catch((error: unknown) =>
          this.options.logger.warn(
            { error: { code: (error as { code?: string }).code } },
            'outbox relay cycle failed',
          ),
        )
        .finally(() => {
          this.#running = undefined;
          if (!this.#stopped) {
            const interval = this.options.intervalMs ?? 250;
            const delay =
              this.#failures === 0
                ? interval
                : Math.min(interval * 2 ** Math.min(this.#failures, 10), MAX_RELAY_BACKOFF_MS);
            this.#timer = setTimeout(tick, delay);
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

  /** Publishes every currently pending row. Returns the number published. */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const published = await this.relayBatch();
      total += published;
      if (published < (this.options.batchSize ?? 50)) break;
    }
    await this.cleanup();
    return total;
  }

  /**
   * Publishes one batch of pending rows, oldest (lowest relay_sequence) first.
   *
   * A failed publish stops the batch and backs off the *relay*, not the row, so after a broker
   * outage the rows still leave in order. A row that has failed POISON_ATTEMPTS times becomes a
   * suspect: the relay tries the next row, and only if that one publishes is the suspect set aside
   * with its own back-off (logged at error level, metric outcome "set-aside"). If the next row
   * fails too, the broker is the problem and nothing is set aside. A set-aside row is never dropped:
   * it stays pending with `attempts` and `last_error`, is retried after its back-off, and is
   * counted by `pending()`/`setAside()` — the outbox is its own dead-letter store.
   */
  private async relayBatch(): Promise<number> {
    const client = await this.options.pool.connect();
    // A connection lost while checked out (database restart, failover, terminated backend) emits
    // 'error' on the client; unhandled, that would crash the process. The pending query fails
    // anyway, the batch rolls back, and its rows are relayed again by the next cycle.
    const onConnectionError = (error: Error) =>
      this.options.logger.warn(
        { error: { name: error.name, code: (error as { code?: string }).code } },
        'outbox relay lost its database connection',
      );
    client.on('error', onConnectionError);
    let failure: Error | undefined;
    let published = 0;
    try {
      await client.query('BEGIN');
      // SKIP LOCKED lets several instances relay concurrently without double-processing a row.
      const rows = await client.query<{
        id: string;
        envelope: EventEnvelope;
        traceparent: string | null;
        attempts: number;
      }>(
        `SELECT id, envelope, traceparent, attempts FROM ${this.#table}
          WHERE published_at IS NULL AND next_attempt_at <= now()
          ORDER BY relay_sequence
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize ?? 50],
      );
      let suspect: { id: string; attempts: number } | undefined;
      for (const row of rows.rows) {
        try {
          await this.options.publisher.publishEnvelope(
            row.envelope,
            row.traceparent ? { traceparent: row.traceparent } : {},
          );
          await client.query(
            `UPDATE ${this.#table} SET published_at = now(), attempts = attempts + 1 WHERE id = $1`,
            [row.id],
          );
          published += 1;
          this.#failures = 0;
          this.options.metrics?.outboxRelayed.inc({ outcome: 'published' });
          if (suspect) {
            // The broker accepted the row behind the suspect: the suspect itself is the problem.
            await this.setAsideRow(client, suspect);
            suspect = undefined;
          }
        } catch (error) {
          this.#failures += 1;
          const attempts = row.attempts + 1;
          await client.query(
            `UPDATE ${this.#table} SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, (error as Error).name.slice(0, 100)],
          );
          this.options.metrics?.outboxRelayed.inc({ outcome: 'failed' });
          this.options.logger.warn(
            { eventId: row.id, attempts },
            'outbox publish failed; will retry',
          );
          if (!suspect && attempts >= POISON_ATTEMPTS) {
            // Probe with the next row: is it this row, or the broker?
            suspect = { id: row.id, attempts };
            continue;
          }
          break; // stop this batch; the next cycle starts from the oldest pending row again
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      failure = error as Error;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.off('error', onConnectionError);
      // Passing the error discards the connection instead of returning a broken one to the pool.
      client.release(failure);
    }
    return published;
  }

  private async setAsideRow(
    client: pg.PoolClient,
    row: { id: string; attempts: number },
  ): Promise<void> {
    const backoffSeconds = Math.min(2 ** Math.min(row.attempts, 8), 300);
    await client.query(
      `UPDATE ${this.#table} SET next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1`,
      [row.id, backoffSeconds],
    );
    this.options.metrics?.outboxRelayed.inc({ outcome: 'set-aside' });
    this.options.logger.error(
      { eventId: row.id, attempts: row.attempts, setAsideSeconds: backoffSeconds },
      'outbox row set aside: it keeps failing while later rows publish; needs investigation',
    );
  }

  private async cleanup(): Promise<void> {
    if (Date.now() - this.#lastCleanup < 60 * 60_000) return;
    this.#lastCleanup = Date.now();
    const retention = Math.round((this.options.retentionMs ?? 7 * 24 * 3600_000) / 1000);
    await this.options.pool.query(
      `DELETE FROM ${this.#table} WHERE published_at < now() - make_interval(secs => $1)`,
      [retention],
    );
  }

  /** Rows that failed at least POISON_ATTEMPTS times and are still unpublished (diagnostics). */
  async setAside(): Promise<number> {
    const result = await this.options.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.#table}
        WHERE published_at IS NULL AND attempts >= $1`,
      [POISON_ATTEMPTS],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Number of rows not yet published (for readiness and diagnostics). */
  async pending(): Promise<number> {
    const result = await this.options.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.#table} WHERE published_at IS NULL`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
