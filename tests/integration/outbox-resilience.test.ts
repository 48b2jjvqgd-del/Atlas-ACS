import { randomBytes, randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import {
  createPostgresConnector,
  createRabbitMqConnector,
  enqueueEvent,
  EVENTS_EXCHANGE,
  EventPublisher,
  inScope,
  OutboxRelay,
  POISON_ATTEMPTS,
  systemScope,
  type RabbitMqConnector,
} from '@atlas/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { infrastructure } from './env.js';

/**
 * Transactional outbox during a broker outage: events committed while RabbitMQ is unreachable are
 * kept (with attempts and the error recorded), retried with back-off, and all delivered — once
 * each, in order — when the broker comes back. Uses the real relay, publisher and broker; the
 * outage is a connector that points at a closed port until "the broker recovers".
 */
const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const runId = randomBytes(3).toString('hex');
const eventType = `atlas.test.outbox-resilience-${runId}.v1`;
let db: TestDatabase;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  db = await createTestDatabase('outbox');
}, 120_000);

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  await db?.drop();
});

/** A connector that fails like an unreachable broker until `restore()` is called. */
function switchableConnector(): RabbitMqConnector & { restore(): void } {
  const down = createRabbitMqConnector({
    url: 'amqp://atlas:x@127.0.0.1:1',
    connectionName: `down-${runId}`,
    logger,
  });
  const up = createRabbitMqConnector({
    url: infrastructure.rabbitmqUrl,
    connectionName: `outbox-${runId}`,
    logger,
  });
  cleanup.push(
    () => up.close(),
    () => down.close(),
  );
  let current = down;
  return {
    connection: () => current.connection(),
    createConfirmChannel: () => current.createConfirmChannel(),
    check: () => current.check(),
    close: () => current.close(),
    restore: () => {
      current = up;
    },
  };
}

const envelope = (n: number): EventEnvelope => ({
  specversion: '1.0',
  id: randomUUID(),
  source: 'urn:atlas:service:issuer-service',
  type: eventType,
  time: new Date().toISOString(),
  datacontenttype: 'application/json',
  dataschema: `urn:atlas:schema:test:${n}`,
  correlationid: `outbox-resilience-${n}`,
  data: { n },
});

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('transactional outbox during a broker outage', () => {
  it('keeps, retries and then delivers every committed event exactly once, in order', async () => {
    const postgres = createPostgresConnector({
      url: db.roleUrl('issuer-service'),
      applicationName: 'integration-outbox',
      logger,
      tenantContextSchema: 'issuer',
    });
    cleanup.push(() => postgres.close());

    // A consumer queue for the test event type, on the real broker.
    const observer = createRabbitMqConnector({
      url: infrastructure.rabbitmqUrl,
      connectionName: `observer-${runId}`,
      logger,
    });
    cleanup.push(() => observer.close());
    const channel = await (await observer.connection()).createChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    const queue = `integration.outbox-${runId}`;
    // Exclusive: RabbitMQ 4 refuses transient non-exclusive queues.
    await channel.assertQueue(queue, { exclusive: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, eventType);
    const received: string[] = [];
    await channel.consume(queue, (message) => {
      if (!message) return;
      received.push((JSON.parse(message.content.toString()) as EventEnvelope).id);
      channel.ack(message);
    });

    const connector = switchableConnector();
    const relay = new OutboxRelay({
      pool: postgres.pool,
      schema: 'issuer',
      publisher: new EventPublisher(connector, 'issuer-service', { logger, attempts: 1 }),
      logger,
      intervalMs: 100,
    });

    // Changes commit while the broker is down; each carries its event in the same transaction.
    const ids: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const e = envelope(n);
      ids.push(e.id);
      await inScope(postgres.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
    }
    relay.start();
    cleanup.push(() => relay.stop());

    await eventually(async () => {
      const row = await postgres.pool.query<{ attempts: number; last_error: string | null }>(
        'SELECT attempts, last_error FROM issuer.outbox WHERE id = $1',
        [ids[0]],
      );
      return (row.rows[0]?.attempts ?? 0) >= 1 && row.rows[0]?.last_error !== null;
    });
    // Nothing was published or dropped during the outage.
    expect(await relay.pending()).toBe(5);
    expect(received).toEqual([]);

    connector.restore();
    await eventually(() => received.length >= 5);
    await relay.stop();
    expect(received).toEqual(ids);
    expect(await relay.pending()).toBe(0);
    const unpublished = await postgres.pool.query(
      'SELECT id FROM issuer.outbox WHERE id = ANY($1) AND published_at IS NULL',
      [ids],
    );
    expect(unpublished.rowCount).toBe(0);
  }, 60_000);

  it('sets aside a row that keeps failing, so it cannot block the events behind it', async () => {
    const postgres = createPostgresConnector({
      url: db.roleUrl('issuer-service'),
      applicationName: 'integration-outbox-poison',
      logger,
      tenantContextSchema: 'issuer',
    });
    cleanup.push(() => postgres.close());
    const broker = createRabbitMqConnector({
      url: infrastructure.rabbitmqUrl,
      connectionName: `poison-${runId}`,
      logger,
    });
    cleanup.push(() => broker.close());
    const poison = envelope(100);
    const healthy = [envelope(101), envelope(102)];
    const delivered: string[] = [];
    class SelectivePublisher extends EventPublisher {
      override async publishEnvelope(e: EventEnvelope, trace?: Record<string, string>) {
        if (e.id === poison.id) throw new Error('message rejected');
        await super.publishEnvelope(e, trace);
        delivered.push(e.id);
      }
    }
    for (const e of [poison, ...healthy]) {
      await inScope(postgres.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
    }
    const relay = new OutboxRelay({
      pool: postgres.pool,
      schema: 'issuer',
      publisher: new SelectivePublisher(broker, 'issuer-service', { logger, attempts: 1 }),
      logger,
      intervalMs: 20,
    });
    relay.start();
    cleanup.push(() => relay.stop());
    await eventually(() => delivered.length === 2);
    await relay.stop();
    expect(delivered).toEqual(healthy.map((e) => e.id));
    const row = await postgres.pool.query<{ attempts: number; published_at: Date | null }>(
      'SELECT attempts, published_at FROM issuer.outbox WHERE id = $1',
      [poison.id],
    );
    // Kept for retry and investigation, never dropped.
    expect(row.rows[0]).toMatchObject({ published_at: null });
    expect(row.rows[0]!.attempts).toBeGreaterThanOrEqual(POISON_ATTEMPTS);
  }, 60_000);
});
