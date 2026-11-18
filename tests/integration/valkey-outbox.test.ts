import { randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { EventEnvelope } from '@atlas/contracts';
import { ValkeyOutbox } from '@atlas/api-gateway/valkey-outbox';
import { createLogger } from '@atlas/observability';
import { EventPublisher, POISON_ATTEMPTS, type RabbitMqConnector } from '@atlas/service-kit';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { infrastructure } from './env.js';

/**
 * The gateway's Valkey outbox against a real Valkey: order through a broker outage, poison items
 * set aside only when later items publish (and retried, never dropped), unreadable entries kept,
 * and at-least-once delivery after a crash mid-publish. The broker side is a recording publisher:
 * what is under test is the outbox's own state handling.
 */
const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const runId = randomBytes(3).toString('hex');
const clients: Redis[] = [];

afterAll(async () => {
  for (const redis of clients) {
    const keys = await redis.keys('*').catch(() => [] as string[]);
    const prefix = redis.options.keyPrefix ?? '';
    if (keys.length) await redis.del(...keys.map((key) => key.slice(prefix.length)));
    redis.disconnect();
  }
});

/** A Valkey connection whose keys live under a prefix unique to one test. */
function valkey(name: string): Redis {
  const redis = new Redis(infrastructure.valkeyUrl, {
    keyPrefix: `it-outbox-${runId}-${name}:`,
    maxRetriesPerRequest: 1,
  });
  clients.push(redis);
  return redis;
}

/** Records what would reach the broker; `reject` decides which publishes fail. */
class RecordingPublisher extends EventPublisher {
  readonly delivered: string[] = [];
  reject: (envelope: EventEnvelope) => boolean = () => false;
  constructor() {
    super({} as RabbitMqConnector, 'api-gateway');
  }
  override async publishEnvelope(envelope: EventEnvelope): Promise<void> {
    if (this.reject(envelope)) throw new Error('publish failed');
    this.delivered.push(envelope.id);
  }
}

const envelope = (n: number): EventEnvelope => ({
  specversion: '1.0',
  id: randomUUID(),
  source: 'urn:atlas:service:api-gateway',
  type: 'atlas.test.valkey-outbox.v1',
  time: new Date().toISOString(),
  datacontenttype: 'application/json',
  dataschema: `urn:atlas:schema:test:${n}`,
  correlationid: `valkey-outbox-${n}`,
  data: { n },
});

async function drainTimes(outbox: ValkeyOutbox, times: number) {
  for (let i = 0; i < times; i += 1) await outbox.drain();
}

describe('gateway Valkey outbox', () => {
  it('keeps order through a long broker outage and sets nothing aside', async () => {
    const redis = valkey('outage');
    const publisher = new RecordingPublisher();
    const outbox = new ValkeyOutbox(redis, publisher, logger);
    const events = Array.from({ length: 6 }, (_, n) => envelope(n));
    for (const e of events) await outbox.enqueue(e);

    publisher.reject = () => true; // broker down
    await drainTimes(outbox, POISON_ATTEMPTS * 3);
    expect(publisher.delivered).toEqual([]);
    expect(await outbox.setAside()).toBe(0);
    expect(await outbox.pending()).toBe(events.length);

    publisher.reject = () => false; // broker back
    await outbox.drain();
    expect(publisher.delivered).toEqual(events.map((e) => e.id));
    expect(await outbox.pending()).toBe(0);
  });

  it('sets a poison item aside once a later item publishes, re-queues it, and never drops it', async () => {
    const redis = valkey('poison');
    const publisher = new RecordingPublisher();
    const outbox = new ValkeyOutbox(redis, publisher, logger, undefined, { setAsideRetryMs: 300 });
    const poison = envelope(100);
    await outbox.enqueue(poison);
    publisher.reject = (e) => e.id === poison.id;

    // Alone it blocks nothing and stays at the head.
    await drainTimes(outbox, POISON_ATTEMPTS + 2);
    expect(await outbox.setAside()).toBe(0);
    expect(await outbox.pending()).toBe(1);

    const healthy = [envelope(101), envelope(102), envelope(103)];
    for (const e of healthy) await outbox.enqueue(e);
    await drainTimes(outbox, POISON_ATTEMPTS + 1);
    expect(publisher.delivered).toEqual(healthy.map((e) => e.id));
    expect(await outbox.setAside()).toBe(1);
    expect(await outbox.pending()).toBe(1);

    // Re-queued after the retry interval; delivered once it can be published.
    publisher.reject = () => false;
    await new Promise((resolve) => setTimeout(resolve, 350));
    await outbox.drain();
    expect(publisher.delivered.filter((id) => id === poison.id)).toHaveLength(1);
    expect(await outbox.pending()).toBe(0);
  });

  it('puts a suspect back at the head when the item behind it fails too (broker, not poison)', async () => {
    const redis = valkey('suspect');
    const publisher = new RecordingPublisher();
    const outbox = new ValkeyOutbox(redis, publisher, logger);
    const events = [envelope(1), envelope(2), envelope(3)];
    for (const e of events) await outbox.enqueue(e);
    publisher.reject = () => true;
    await drainTimes(outbox, POISON_ATTEMPTS + 4); // several probes, all failing
    expect(await outbox.setAside()).toBe(0);
    publisher.reject = () => false;
    await outbox.drain();
    expect(publisher.delivered).toEqual(events.map((e) => e.id));
  });

  it('keeps an unreadable entry for investigation and carries on with the rest', async () => {
    const redis = valkey('unreadable');
    const publisher = new RecordingPublisher();
    const outbox = new ValkeyOutbox(redis, publisher, logger);
    const before = envelope(1);
    const after = envelope(2);
    await outbox.enqueue(before);
    await redis.lpush('outbox', '{not json');
    await outbox.enqueue(after);
    await outbox.drain();
    expect(publisher.delivered).toEqual([before.id, after.id]);
    expect(await redis.lrange('outbox:unreadable', 0, -1)).toEqual(['{not json']);
  });

  it('re-publishes an item left in the processing list by a crash (at-least-once)', async () => {
    const redis = valkey('crash');
    const publisher = new RecordingPublisher();
    const crashed = envelope(1);
    const next = envelope(2);
    const first = new ValkeyOutbox(redis, publisher, logger);
    await first.enqueue(crashed);
    await first.enqueue(next);
    // The crashed instance had claimed the item (and possibly published it) but not removed it.
    await redis.lmove('outbox', `outbox:processing:${hostname()}`, 'RIGHT', 'LEFT');
    const restarted = new ValkeyOutbox(redis, publisher, logger);
    await restarted.drain();
    expect(publisher.delivered).toEqual([crashed.id, next.id]);
    expect(await restarted.pending()).toBe(0);
  });
});
