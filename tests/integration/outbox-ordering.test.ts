import { randomBytes, randomUUID } from 'node:crypto';
import { activityRecordedV1, type EventEnvelope, type ServiceName } from '@atlas/contracts';
import { appendRecord, chainOf, verifyChain } from '@atlas/audit-service/store';
import { createLogger } from '@atlas/observability';
import {
  buildEnvelope,
  createPostgresConnector,
  createRabbitMqConnector,
  enqueueEvent,
  EVENTS_EXCHANGE,
  EventPublisher,
  inScope,
  OutboxRelay,
  POISON_ATTEMPTS,
  subscribe,
  systemScope,
  type PostgresConnector,
  type RabbitMqConnector,
} from '@atlas/service-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from './database.js';
import { infrastructure } from './env.js';

/**
 * What the transactional outbox actually guarantees about ordering, demonstrated against a real
 * PostgreSQL and RabbitMQ (ADR-037):
 *
 *   guaranteed      no loss; no double publish by concurrent relays; at-least-once across a relay
 *                   crash; poison rows never block the outbox and are never dropped
 *   best effort     one relay publishes the rows it can see in insertion order (also after an
 *                   outage, however long)
 *   NOT guaranteed  commit order across overlapping transactions; any order across relay instances
 *
 * and that the only consumer (audit-service) is correct under duplicates, retries and arbitrary
 * arrival order, which is why strict ordering is not required.
 */
const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const runId = randomBytes(3).toString('hex');
let db: TestDatabase;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  db = await createTestDatabase('ordering');
}, 120_000);

// Per test: each service role has a connection limit (25), shared with parallel test files.
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
});

afterAll(async () => {
  await db?.drop();
});

// ------------------------------------------------------------------------------------- helpers

function postgres(service: ServiceName, schema: string, name: string): PostgresConnector {
  const connector = createPostgresConnector({
    url: db.roleUrl(service),
    applicationName: `it-ordering-${name}-${runId}`,
    logger,
    tenantContextSchema: schema,
  });
  cleanup.push(() => connector.close());
  return connector;
}

function broker(name: string): RabbitMqConnector {
  const connector = createRabbitMqConnector({
    url: infrastructure.rabbitmqUrl,
    connectionName: `it-ordering-${name}-${runId}`,
    logger,
  });
  cleanup.push(() => connector.close());
  return connector;
}

/** A connector that fails like an unreachable broker until `restore()` is called. */
function switchableConnector(name: string): RabbitMqConnector & { restore(): void } {
  const down = createRabbitMqConnector({
    url: 'amqp://atlas:x@127.0.0.1:1',
    connectionName: `down-${name}-${runId}`,
    logger,
  });
  const up = broker(name);
  cleanup.push(() => down.close());
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

/** Records the ids of every event of `type` reaching the broker, in arrival order. */
async function observe(type: string): Promise<string[]> {
  const connector = broker(`observer-${type}`);
  const channel = await (await connector.connection()).createChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  const queue = `integration.${type}`;
  // Exclusive: RabbitMQ 4 refuses transient non-exclusive queues.
  await channel.assertQueue(queue, { exclusive: true });
  await channel.bindQueue(queue, EVENTS_EXCHANGE, type);
  const received: string[] = [];
  await channel.consume(queue, (message) => {
    if (!message) return;
    received.push((JSON.parse(message.content.toString()) as EventEnvelope).id);
    channel.ack(message);
  });
  return received;
}

const eventTypeFor = (name: string) => `atlas.test.ordering-${name}-${runId}.v1`;

const envelope = (type: string, n: number): EventEnvelope => ({
  specversion: '1.0',
  id: randomUUID(),
  source: 'urn:atlas:service:issuer-service',
  type,
  time: new Date().toISOString(),
  datacontenttype: 'application/json',
  dataschema: `urn:atlas:schema:test:${n}`,
  correlationid: `outbox-ordering-${n}`,
  data: { n },
});

function relay(
  pg: PostgresConnector,
  connector: RabbitMqConnector,
  options: Partial<ConstructorParameters<typeof OutboxRelay>[0]> = {},
): OutboxRelay {
  const instance = new OutboxRelay({
    pool: pg.pool,
    schema: 'issuer',
    publisher: new EventPublisher(connector, 'issuer-service', { logger, attempts: 1 }),
    logger,
    intervalMs: 10,
    ...options,
  });
  cleanup.push(() => instance.stop());
  return instance;
}

async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const outboxRow = async (pg: PostgresConnector, id: string) =>
  (
    await pg.pool.query<{
      attempts: number;
      published_at: Date | null;
      last_error: string | null;
      set_aside: boolean;
    }>(
      `SELECT attempts, published_at, last_error, next_attempt_at > now() AS set_aside
         FROM issuer.outbox WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

// --------------------------------------------------------------------------- single relay

describe('outbox ordering: one relay', () => {
  it('publishes the events of one transaction in the order they were written', async () => {
    const pg = postgres('issuer-service', 'issuer', 'single-tx');
    const type = eventTypeFor('single-tx');
    const received = await observe(type);
    const events = Array.from({ length: 25 }, (_, n) => envelope(type, n));
    await inScope(pg.pool, systemScope, async (client) => {
      for (const e of events) await enqueueEvent(client, 'issuer', e);
    });
    // All rows share created_at (transaction start time): created_at alone could not order them.
    const createdAt = await pg.pool.query(
      'SELECT DISTINCT created_at FROM issuer.outbox WHERE id = ANY($1)',
      [events.map((e) => e.id)],
    );
    expect(createdAt.rowCount).toBe(1);

    await relay(pg, broker('single-tx'), { batchSize: 7 }).drain();
    await eventually(() => received.length >= events.length);
    expect(received).toEqual(events.map((e) => e.id));
  });

  it('does not preserve commit order across overlapping transactions (best effort only)', async () => {
    const pg = postgres('issuer-service', 'issuer', 'overlap');
    const type = eventTypeFor('overlap');
    const received = await observe(type);
    const relayer = relay(pg, broker('overlap'));
    const early = envelope(type, 1);
    const late = envelope(type, 2);

    // Transaction A starts and writes first, but commits last.
    const a = await pg.pool.connect();
    try {
      await a.query('BEGIN');
      await a.query(`SELECT issuer.begin_tenant_context('all', '{}')`);
      await enqueueEvent(a, 'issuer', early);
      await inScope(pg.pool, systemScope, (client) => enqueueEvent(client, 'issuer', late));
      await relayer.drain(); // sees only the committed row
      await a.query('COMMIT');
    } finally {
      a.release();
    }
    await relayer.drain();
    await eventually(() => received.length >= 2);

    // Neither created_at nor relay_sequence reflects commit order: both say "early" came first.
    const rows = await pg.pool.query<{ id: string }>(
      'SELECT id FROM issuer.outbox WHERE id = ANY($1) ORDER BY relay_sequence',
      [[early.id, late.id]],
    );
    expect(rows.rows.map((r) => r.id)).toEqual([early.id, late.id]);
    // ...yet the event that committed first was published first. Consumers must not assume order.
    expect(received).toEqual([late.id, early.id]);
  });

  it('keeps insertion order through a long broker outage without setting rows aside', async () => {
    const pg = postgres('issuer-service', 'issuer', 'outage');
    const type = eventTypeFor('outage');
    const received = await observe(type);
    const connector = switchableConnector('outage');
    const events = Array.from({ length: 8 }, (_, n) => envelope(type, n));
    for (const e of events) {
      await inScope(pg.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
    }
    const relayer = relay(pg, connector);
    relayer.start();

    // Outage long enough for the head row to exceed the poison threshold several times over.
    await eventually(
      async () => (await outboxRow(pg, events[0]!.id)).attempts >= POISON_ATTEMPTS + 2,
    );
    const head = await outboxRow(pg, events[0]!.id);
    expect(head).toMatchObject({ published_at: null, set_aside: false });
    expect(head.last_error).not.toBeNull();
    expect(received).toEqual([]);

    connector.restore();
    await eventually(() => received.length >= events.length);
    await relayer.stop();
    // Previously the head rows were set aside one by one during the outage and left out of order.
    expect(received).toEqual(events.map((e) => e.id));
    expect(await relayer.pending()).toBe(0);
  }, 60_000);
});

// ------------------------------------------------------------------------------ poison rows

describe('outbox ordering: poison rows', () => {
  it('sets a poison row aside only once a later row publishes, retries it, and never drops it', async () => {
    const pg = postgres('issuer-service', 'issuer', 'poison');
    const type = eventTypeFor('poison');
    const received = await observe(type);
    const poison = envelope(type, 100);
    let poisonAccepted = false;
    class SelectivePublisher extends EventPublisher {
      override async publishEnvelope(e: EventEnvelope, trace?: Record<string, string>) {
        if (e.id === poison.id && !poisonAccepted) throw new Error('message rejected');
        await super.publishEnvelope(e, trace);
      }
    }
    await inScope(pg.pool, systemScope, (client) => enqueueEvent(client, 'issuer', poison));
    const relayer = relay(pg, broker('poison'), {
      publisher: new SelectivePublisher(broker('poison-publisher'), 'issuer-service', {
        logger,
        attempts: 1,
      }),
    });
    relayer.start();

    // Alone, it blocks nothing: it is retried with the relay's back-off (no hot loop), not set aside.
    await sleep(3_000);
    const alone = await outboxRow(pg, poison.id);
    expect(alone.attempts).toBeGreaterThanOrEqual(POISON_ATTEMPTS);
    expect(alone.attempts).toBeLessThan(15);
    expect(alone.set_aside).toBe(false);

    // Rows behind it: the poison row is set aside and they are published in order.
    const healthy = [envelope(type, 101), envelope(type, 102), envelope(type, 103)];
    for (const e of healthy) {
      await inScope(pg.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
    }
    await eventually(() => received.length >= healthy.length);
    expect(received).toEqual(healthy.map((e) => e.id));
    const setAside = await outboxRow(pg, poison.id);
    expect(setAside).toMatchObject({ published_at: null, set_aside: true });
    expect(setAside.last_error).toBe('Error');
    expect(await relayer.setAside()).toBe(1);
    expect(await relayer.pending()).toBe(1);

    // Once it can be published (cause fixed, back-off elapsed) it is delivered — exactly once.
    poisonAccepted = true;
    await pg.pool.query('UPDATE issuer.outbox SET next_attempt_at = now() WHERE id = $1', [
      poison.id,
    ]);
    await eventually(() => received.includes(poison.id));
    await relayer.stop();
    expect(received.filter((id) => id === poison.id)).toHaveLength(1);
    expect(await relayer.pending()).toBe(0);
    expect(await relayer.setAside()).toBe(0);
  }, 60_000);
});

// ------------------------------------------------------------------- multiple relay instances

describe('outbox ordering: several relay instances', () => {
  it('delivers every event exactly once under concurrent writers and relays, in no guaranteed order', async ({
    annotate,
  }) => {
    const type = eventTypeFor('multi');
    const received = await observe(type);
    const writers = postgres('issuer-service', 'issuer', 'writers');
    const publishedBy = new Map<number, number>();
    class CountingPublisher extends EventPublisher {
      constructor(
        connector: RabbitMqConnector,
        private readonly instance: number,
      ) {
        super(connector, 'issuer-service', { logger, attempts: 1 });
      }
      override async publishEnvelope(e: EventEnvelope, trace?: Record<string, string>) {
        await sleep(1); // widen the window in which relays overlap
        await super.publishEnvelope(e, trace);
        publishedBy.set(this.instance, (publishedBy.get(this.instance) ?? 0) + 1);
      }
    }
    // Four instances, each with its own pool and broker connection, as four service replicas.
    const relays = [0, 1, 2, 3].map((instance) =>
      relay(postgres('issuer-service', 'issuer', `relay-${instance}`), broker(`r${instance}`), {
        batchSize: 5,
        publisher: new CountingPublisher(broker(`p${instance}`), instance),
      }),
    );
    for (const r of relays) r.start();

    // Twelve concurrent writers, each committing 25 single-event transactions.
    const ids: string[] = [];
    await Promise.all(
      Array.from({ length: 12 }, async (_, writer) => {
        for (let n = 0; n < 25; n += 1) {
          const e = envelope(type, writer * 100 + n);
          ids.push(e.id);
          await inScope(writers.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
        }
      }),
    );
    await eventually(() => received.length >= ids.length, 60_000);
    for (const r of relays) await r.stop();
    await sleep(500); // anything published twice would arrive by now

    expect(received).toHaveLength(ids.length); // no duplicates
    expect(new Set(received)).toEqual(new Set(ids)); // no loss
    expect(await relays[0]!.pending()).toBe(0);
    // The relays really did work concurrently.
    expect([...publishedBy.values()].filter((count) => count > 0).length).toBeGreaterThan(1);

    // Measured, not asserted: how far arrival order departs from insertion order.
    const sequence = await writers.pool.query<{ id: string }>(
      'SELECT id FROM issuer.outbox WHERE id = ANY($1) ORDER BY relay_sequence',
      [ids],
    );
    const position = new Map(sequence.rows.map((row, index) => [row.id, index]));
    let inversions = 0;
    for (let i = 1; i < received.length; i += 1) {
      if (position.get(received[i]!)! < position.get(received[i - 1]!)!) inversions += 1;
    }
    await annotate(
      `${ids.length} events, relays ${JSON.stringify(Object.fromEntries(publishedBy))}, ` +
        `${inversions} adjacent inversions against insertion order`,
    );
  }, 120_000);

  it('re-publishes after a relay crash mid-batch (at-least-once), and a restarted relay finishes the work', async () => {
    const type = eventTypeFor('crash');
    const received = await observe(type);
    const crashing = postgres('issuer-service', 'issuer', 'crash');
    const events = Array.from({ length: 10 }, (_, n) => envelope(type, n));
    for (const e of events) {
      await inScope(crashing.pool, systemScope, (client) => enqueueEvent(client, 'issuer', e));
    }
    let published = 0;
    class CrashingPublisher extends EventPublisher {
      override async publishEnvelope(e: EventEnvelope, trace?: Record<string, string>) {
        await super.publishEnvelope(e, trace);
        published += 1;
        if (published === 4) {
          // The broker has confirmed four events; the relay's transaction dies before it commits.
          await withClient(db.adminUrl, (client) =>
            client.query(
              `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                WHERE application_name = $1 AND state = 'idle in transaction'`,
              [`it-ordering-crash-${runId}`],
            ),
          );
        }
      }
    }
    const first = relay(crashing, broker('crash'), {
      publisher: new CrashingPublisher(broker('crash-publisher'), 'issuer-service', {
        logger,
        attempts: 1,
      }),
    });
    await expect(first.drain()).rejects.toThrow();
    await eventually(() => received.length >= 4);
    // Nothing was marked published: the crash rolled the batch back.
    const restarted = relay(postgres('issuer-service', 'issuer', 'restarted'), broker('restarted'));
    expect(await restarted.pending()).toBe(events.length);

    await restarted.drain();
    await eventually(() => received.length >= 4 + events.length);
    const ids = events.map((e) => e.id);
    // Four duplicates, each event at least once, first deliveries still in insertion order.
    expect(received).toHaveLength(14);
    expect(received.slice(0, 4)).toEqual(ids.slice(0, 4));
    expect(received.slice(4)).toEqual(ids);
    expect(await restarted.pending()).toBe(0);
  }, 60_000);
});

// --------------------------------------------------------------- consumer order independence

describe('the audit consumer does not depend on order', () => {
  it('stores every event once with valid chains, through concurrent relays, retries and duplicates', async () => {
    const issuerPg = postgres('issuer-service', 'issuer', 'e2e-issuer');
    const identityPg = postgres('identity-service', 'identity', 'e2e-identity');
    const auditPg = postgres('audit-service', 'audit', 'e2e-audit');
    const tenants = [randomUUID(), randomUUID()];
    const marker = `ordering-${runId}`;

    // The real consumer path: subscribe() with retry queues, the audit store's appendRecord.
    // Every fifth event fails on first delivery, so it is retried after later events.
    const failedOnce = new Set<string>();
    let deliveries = 0;
    const consumer = broker('e2e-consumer');
    const subscription = await subscribe({
      connector: consumer,
      service: 'audit-service',
      name: `it-ordering-${runId}`,
      contract: activityRecordedV1,
      logger,
      prefetch: 20,
      retryDelaysMs: [100, 300],
      handler: async (event) => {
        if (event.data.resource.id !== marker) return; // other tests' events share the exchange
        deliveries += 1;
        if (Number(event.data.metadata?.n) % 5 === 0 && !failedOnce.has(event.id)) {
          failedOnce.add(event.id);
          throw new Error('transient failure');
        }
        await inScope(auditPg.pool, systemScope, (client) => appendRecord(client, event));
      },
    });
    cleanup.push(async () => {
      await subscription.cancel();
      const channel = await (await consumer.connection()).createChannel();
      for (const queue of [
        subscription.queue,
        subscription.deadLetterQueue,
        ...subscription.retryQueues,
      ])
        await channel.deleteQueue(queue).catch(() => undefined);
    });

    const activity = (service: ServiceName, n: number, tenantId: string | undefined) =>
      buildEnvelope(
        activityRecordedV1,
        {
          occurredAt: new Date().toISOString(),
          actor: { type: 'system', id: 'integration' },
          ...(tenantId ? { tenantId } : {}),
          action: 'test.ordering',
          resource: { type: 'test', id: marker },
          outcome: 'success',
          metadata: { n },
        },
        { service, correlationId: `${marker}-${n}`, ...(tenantId ? { tenantId } : {}) },
      );

    // Two issuer-service relays and one identity-service relay, writers committing concurrently.
    const relays = [
      relay(issuerPg, broker('e2e-r1'), { batchSize: 4 }),
      relay(postgres('issuer-service', 'issuer', 'e2e-issuer-2'), broker('e2e-r2'), {
        batchSize: 4,
      }),
      new OutboxRelay({
        pool: identityPg.pool,
        schema: 'identity',
        publisher: new EventPublisher(broker('e2e-r3'), 'identity-service', { logger }),
        logger,
        intervalMs: 10,
        batchSize: 4,
      }),
    ];
    cleanup.push(() => relays[2]!.stop());
    for (const r of relays) r.start();

    const sent: EventEnvelope[] = [];
    await Promise.all(
      [0, 1, 2, 3].map(async (writer) => {
        for (let i = 0; i < 15; i += 1) {
          const n = writer * 100 + i;
          const tenantId = i % 3 === 2 ? undefined : tenants[i % 2]; // two issuers + platform
          const fromIdentity = writer === 3;
          const e = activity(fromIdentity ? 'identity-service' : 'issuer-service', n, tenantId);
          sent.push(e);
          const pg = fromIdentity ? identityPg : issuerPg;
          await inScope(pg.pool, systemScope, (client) =>
            enqueueEvent(client, fromIdentity ? 'identity' : 'issuer', e),
          );
        }
      }),
    );
    // Duplicates, as after a relay crash: ten events published a second time.
    const duplicates = sent.slice(0, 10);
    const direct = new EventPublisher(broker('e2e-dup'), 'issuer-service', { logger });
    for (const e of duplicates) await direct.publishEnvelope(e);

    const ids = sent.map((e) => e.id);
    // Read with platform scope: without a tenant context RLS hides every row.
    const count = () =>
      inScope(auditPg.pool, systemScope, async (client) =>
        Number(
          (
            await client.query<{ count: string }>(
              'SELECT count(*)::text AS count FROM audit.audit_record WHERE id = ANY($1)',
              [ids],
            )
          ).rows[0]!.count,
        ),
      );
    await eventually(async () => (await count()) === ids.length, 60_000);
    await eventually(() => deliveries >= ids.length + duplicates.length + failedOnce.size, 30_000);
    for (const r of relays) await r.stop();

    expect(failedOnce.size).toBeGreaterThan(0);
    expect(await count()).toBe(ids.length); // each event once, duplicates ignored
    for (const chain of [...tenants, null]) {
      const result = await inScope(auditPg.pool, systemScope, (client) =>
        verifyChain(client, chainOf(chain)),
      );
      expect(result.valid, `chain ${chainOf(chain)}`).toBe(true);
    }
    // The chain order is arrival order, which differs from the order the events were written.
    const order = await inScope(auditPg.pool, systemScope, (client) =>
      client.query<{ id: string }>(
        'SELECT id FROM audit.audit_record WHERE id = ANY($1) ORDER BY sequence',
        [ids],
      ),
    );
    expect(new Set(order.rows.map((r) => r.id))).toEqual(new Set(ids));
    expect(order.rows.map((r) => r.id)).not.toEqual(ids);
  }, 120_000);
});
