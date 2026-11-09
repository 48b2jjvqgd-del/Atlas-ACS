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
 * rows wait and are retried with back-off; nothing is lost. Delivery is at-least-once, so
 * consumers deduplicate by event id.
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

export class OutboxRelay {
  #timer: NodeJS.Timeout | undefined;
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
            this.#timer = setTimeout(tick, this.options.intervalMs ?? 250);
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

  private async relayBatch(): Promise<number> {
    const client = await this.options.pool.connect();
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
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.options.batchSize ?? 50],
      );
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
          this.options.metrics?.outboxRelayed.inc({ outcome: 'published' });
        } catch (error) {
          const backoffSeconds = Math.min(2 ** Math.min(row.attempts, 8), 300);
          await client.query(
            `UPDATE ${this.#table}
                SET attempts = attempts + 1, last_error = $2,
                    next_attempt_at = now() + make_interval(secs => $3)
              WHERE id = $1`,
            [row.id, (error as Error).name.slice(0, 100), backoffSeconds],
          );
          this.options.metrics?.outboxRelayed.inc({ outcome: 'failed' });
          this.options.logger.warn(
            { eventId: row.id, attempts: row.attempts + 1, retryInSeconds: backoffSeconds },
            'outbox publish failed; will retry',
          );
          break; // broker likely unavailable: stop this batch, keep ordering
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return published;
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

  /** Number of rows not yet published (for readiness and diagnostics). */
  async pending(): Promise<number> {
    const result = await this.options.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.#table} WHERE published_at IS NULL`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
