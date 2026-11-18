import { randomBytes, randomUUID } from 'node:crypto';
import {
  activityRecordedV1,
  defineEvent,
  type ActivityRecorded,
  type EventEnvelope,
} from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import {
  AT_LEAST_ONCE_QUORUM_ARGUMENTS,
  buildEnvelope,
  createRabbitMqConnector,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE_ARGUMENTS,
  DEAD_LETTERED_FROM_HEADER,
  EVENTS_EXCHANGE,
  EventPublisher,
  ATTEMPT_HEADER,
  DEATH_HISTORY_HEADER,
  inspectTopology,
  mainQueueArguments,
  moveMessages,
  REPLAY_COUNT_HEADER,
  replayDeadLetters,
  retireLegacyQueues,
  retryQueueArguments,
  rollBackToLegacy,
  subscribe,
  subscriptionTopology,
  UnroutableMessageError,
  type Subscription,
  type SubscriptionTopology,
} from '@atlas/service-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { infrastructure } from './env.js';

/**
 * Queue-topology version 2 (ADR-038; Stage 1A final review F-01), against the real broker:
 *   - the broker holds the at-least-once arguments on every version-2 queue (an at-most-once
 *     redeclaration is refused as inequivalent), and the dead-letter queue has no delivery limit;
 *   - migration: a version-2 consumer unbinds the version-1 queue and drains it, including
 *     messages still waiting in version-1 delay queues and version-1 poison messages, applying
 *     each side effect once and losing nothing;
 *   - retirement refuses while version-1 queues hold messages, then deletes them and moves the
 *     version-1 dead letters into the version-2 dead-letter queue;
 *   - version-1 and version-2 instances coexist (the version-1 one keeps re-binding its queue):
 *     every event applied once, and the binding does not outlive the version-1 instance;
 *   - retirement and rollback are idempotent, and rollback refuses while version-2 consumers run;
 *   - a message in a version-2 delay queue is moved by rollback only after its own delay, with every
 *     property and header intact;
 *   - an internal publish to a missing queue fails instead of being confirmed and dropped;
 *   - dead letters say why they died, survive inspection, and replay keeps the event id and the
 *     failure history; a replayed event that fails again is dead-lettered again, still recoverable;
 *   - rollback re-binds the version-1 queue before unbinding version 2 and moves every
 *     version-2 message (main and delay queues) into it.
 */
const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
const tag = [...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
const contract = defineEvent({
  type: `atlas.test.queue-migration-${tag}.v1`,
  dataSchema: activityRecordedV1.dataSchema,
  producers: ['issuer-service'],
  description: 'Integration test event (queue topology migration)',
});
const connector = createRabbitMqConnector({
  url: infrastructure.rabbitmqUrl,
  connectionName: `integration-migration-${tag}`,
  logger,
});
const publisher = new EventPublisher(connector, 'issuer-service', { logger });
const createdQueues = new Set<string>();
const cleanup: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  const channel = await (await connector.connection()).createChannel();
  channel.on('error', () => undefined);
  for (const queue of createdQueues) await channel.deleteQueue(queue).catch(() => undefined);
  await channel.close().catch(() => undefined);
  await connector.close();
});

const data = (n: number): ActivityRecorded => ({
  occurredAt: new Date().toISOString(),
  actor: { type: 'system', id: 'integration' },
  action: 'test.queue-migration',
  resource: { type: 'test', id: String(n) },
  outcome: 'success',
});
const envelope = (n: number) =>
  buildEnvelope(contract, data(n), { service: 'issuer-service', correlationId: randomUUID() });

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      await Promise.resolve()
        .then(check)
        .catch(() => false)
    )
      return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const ref = (name: string) => ({
  service: 'audit-service',
  name,
  retries: 2,
  routingKey: contract.type,
});

function track(topology: SubscriptionTopology, legacyRetries = 2) {
  for (const queue of [
    topology.queue,
    topology.deadLetterQueue,
    ...topology.retryQueues,
    topology.legacy.queue,
    topology.legacy.deadLetterQueue,
    ...Array.from({ length: legacyRetries }, (_, i) => topology.legacy.retryQueue(i + 1)),
  ])
    createdQueues.add(queue);
}

/** Declares a subscription's topology exactly as the version-1 code did (before F-01). */
async function declareVersion1(
  topology: SubscriptionTopology,
  retryDelaysMs: readonly number[],
): Promise<void> {
  const channel = await connector.createConfirmChannel();
  await channel.assertQueue(topology.legacy.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(topology.legacy.deadLetterQueue, DEAD_LETTER_EXCHANGE, topology.base);
  await channel.assertQueue(topology.legacy.queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': topology.base,
    },
  });
  await channel.bindQueue(topology.legacy.queue, EVENTS_EXCHANGE, contract.type);
  for (const [index, ttl] of retryDelaysMs.entries())
    await channel.assertQueue(topology.legacy.retryQueue(index + 1), {
      durable: true,
      arguments: {
        'x-message-ttl': ttl,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': topology.base,
      },
    });
  await channel.close();
}

async function count(queue: string): Promise<number> {
  return (await check(queue)).messageCount;
}

async function check(queue: string) {
  const channel = await (await connector.connection()).createChannel();
  const result = await channel.checkQueue(queue);
  await channel.close();
  return result;
}

async function send(queue: string, message: EventEnvelope, headers: Record<string, unknown> = {}) {
  const channel = await connector.createConfirmChannel();
  channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    messageId: message.id,
    contentType: 'application/cloudevents+json',
    headers,
  });
  await channel.waitForConfirms();
  await channel.close();
}

/** Redeclares a queue on a throwaway channel: resolves only if the broker holds these arguments. */
async function holdsArguments(queue: string, args: Record<string, unknown>): Promise<boolean> {
  const channel = await connector.createConfirmChannel();
  channel.on('error', () => undefined);
  try {
    await channel.assertQueue(queue, { durable: true, arguments: args });
    await channel.close();
    return true;
  } catch {
    return false;
  }
}

function consumer(name: string, handle: (n: number, event: EventEnvelope) => void) {
  return subscribe({
    connector,
    service: 'audit-service',
    name,
    contract,
    logger,
    retryDelaysMs: [300, 300],
    handler: async (event) => handle(Number(event.data.resource.id), event),
  });
}

describe('Queue topology version 2 and its migration (real broker)', () => {
  it('declares at-least-once quorum queues and an unlimited dead-letter queue', async () => {
    const name = `it-mig-args-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology, 0);
    const subscription = await consumer(name, () => undefined);
    cleanup.push(() => subscription.cancel());

    expect(subscription.queue).toBe(`audit-service.${name}.v2`);
    expect(await holdsArguments(topology.queue, mainQueueArguments(topology))).toBe(true);
    for (const [index, queue] of topology.retryQueues.entries())
      expect(
        await holdsArguments(queue, retryQueueArguments(topology, 300)),
        `retry ${index}`,
      ).toBe(true);
    expect(await holdsArguments(topology.deadLetterQueue, { ...DEAD_LETTER_QUEUE_ARGUMENTS })).toBe(
      true,
    );
    // The same queues are NOT equivalent to the at-most-once (version 1) declarations.
    const { 'x-dead-letter-strategy': _strategy, ...atMostOnce } = mainQueueArguments(topology);
    expect(await holdsArguments(topology.queue, atMostOnce)).toBe(false);
    expect(await holdsArguments(topology.retryQueues[0]!, { 'x-message-ttl': 300 })).toBe(false);
    expect(AT_LEAST_ONCE_QUORUM_ARGUMENTS['x-overflow']).toBe('reject-publish');

    // A dead letter survives being inspected and returned many times (version 1 deleted it
    // after 20: RabbitMQ 4's default quorum delivery limit with no dead-letter target).
    const dead = envelope(1);
    await send(topology.deadLetterQueue, dead);
    for (let i = 0; i < 25; i += 1) {
      const channel = await (await connector.connection()).createChannel();
      expect(await channel.get(topology.deadLetterQueue, { noAck: false })).not.toBe(false);
      await channel.close(); // unacknowledged: returned to the queue
    }
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1, 5_000);
  });

  it('drains version 1 (main, delay queues, poison) without loss, then retires it', async () => {
    const name = `it-mig-drain-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology);
    await declareVersion1(topology, [1_500, 1_500]);

    // Version-1 state left behind by the previous release:
    const inMain = [0, 1, 2, 3, 4].map(envelope); // routed to the version-1 main queue
    for (const e of inMain) await publisher.publishEnvelope(e);
    const inDelay = [5, 6].map(envelope); // waiting in a version-1 delay queue (attempt 2)
    for (const e of inDelay) await send(topology.legacy.retryQueue(1), e, { 'x-atlas-attempt': 2 });
    // Fails every attempt, and has used up its retries under version 1: dead-lettered at once.
    const poison = envelope(7);
    await send(topology.legacy.queue, poison, { 'x-atlas-attempt': 3 });
    const oldDeadLetters = [8, 9].map(envelope); // already dead-lettered under version 1
    for (const e of oldDeadLetters) await send(topology.legacy.deadLetterQueue, e);
    await eventually(async () => (await count(topology.legacy.queue)) === 6);

    // Version-2 consumer deployed.
    const applied = new Map<number, number>();
    const subscription: Subscription = await consumer(name, (n) => {
      if (n === 7) throw new Error('permanent failure');
      applied.set(n, (applied.get(n) ?? 0) + 1);
    });
    cleanup.push(() => subscription.cancel());
    expect(subscription.drainingLegacyQueue).toBe(true);

    // New events go to version 2 only: the version-1 queue was unbound.
    const fresh = [10, 11].map(envelope);
    for (const e of fresh) await publisher.publishEnvelope(e);

    await eventually(() => [0, 1, 2, 3, 4, 5, 6, 10, 11].every((n) => applied.has(n)));
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect([...applied.values()].every((c) => c === 1)).toBe(true);
    expect(applied.size).toBe(9);
    expect(await count(topology.legacy.queue)).toBe(0);

    // The version-1 poison message is in the version-2 DLQ, marked with where it came from.
    const peek = await (await connector.connection()).createChannel();
    const deadLetter = await peek.get(topology.deadLetterQueue, { noAck: false });
    expect(deadLetter && deadLetter.properties.messageId).toBe(poison.id);
    expect(deadLetter && deadLetter.properties.headers?.[DEAD_LETTERED_FROM_HEADER]).toBe(
      topology.legacy.queue,
    );
    await peek.close();

    // Retirement refuses while a version-1 queue holds a message …
    const late = envelope(12);
    await send(topology.legacy.retryQueue(2), late, { 'x-atlas-attempt': 3 });
    const refused = await retireLegacyQueues(connector, ref(name));
    expect(refused.refused).toMatch(/not empty/);
    expect(refused.retired).toEqual([]);
    await eventually(() => applied.has(12)); // … which drains through the version-1 main queue
    await eventually(async () => (await count(topology.legacy.retryQueue(2))) === 0);

    // Once the version-1 queue is empty and nothing from it is unacknowledged, the version-2
    // consumer stops consuming it: "no messages, no consumers" means nothing is in flight.
    await eventually(async () => (await check(topology.legacy.queue)).consumerCount === 0, 10_000);
    expect(subscription.drainingLegacyQueue).toBe(true); // still watched until it is retired

    // A consumer that is still attached (a version-1 deployment) also blocks retirement.
    const oldConsumer = await (await connector.connection()).createChannel();
    await oldConsumer.consume(topology.legacy.queue, () => undefined);
    const blocked = await retireLegacyQueues(connector, ref(name));
    expect(blocked.refused).toMatch(/consumer/);
    expect(blocked.retired).toEqual([]);
    await oldConsumer.close();
    await eventually(async () => (await check(topology.legacy.queue)).consumerCount === 0, 10_000);

    // … and succeeds once all are empty: version-1 dead letters move to the version-2 DLQ.
    const retired = await retireLegacyQueues(connector, ref(name));
    expect(retired.refused).toBeUndefined();
    expect(retired.retired).toEqual([
      topology.legacy.retryQueue(2),
      topology.legacy.retryQueue(1),
      topology.legacy.queue,
      topology.legacy.deadLetterQueue,
    ]);
    expect(retired.deadLettersMoved).toBe(2);
    expect(await count(topology.deadLetterQueue)).toBe(3);
    const state = await inspectTopology(connector, ref(name));
    expect(state.filter((q) => q.version === 1 && q.exists)).toEqual([]);
    // Repeating it is a no-op.
    expect(await retireLegacyQueues(connector, ref(name))).toEqual({
      retired: [],
      deadLettersMoved: 0,
    });

    // The consumer noticed and keeps working on version 2 without resubscribing.
    await eventually(() => !subscription.drainingLegacyQueue);
    const generations = subscription.generations;
    await publisher.publishEnvelope(envelope(13));
    await eventually(() => applied.has(13));
    expect(subscription.generations).toBe(generations);
    expect([...applied.values()].every((c) => c === 1)).toBe(true);
  });

  it('lets version-1 and version-2 instances coexist: every event applied once', async () => {
    const name = `it-mig-coexist-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology);
    await declareVersion1(topology, [1_500, 1_500]);

    // One shared idempotent side effect, as both instances write to the same database.
    const applied = new Map<number, number>();
    let duplicates = 0;
    const apply = (n: number) => {
      if (applied.has(n)) duplicates += 1;
      else applied.set(n, 1);
    };

    // A version-1 instance: consumes its queue and re-binds it on every "resubscription".
    const v1 = await connector.createConfirmChannel();
    await v1.consume(topology.legacy.queue, (message) => {
      if (!message) return;
      apply(Number(JSON.parse(message.content.toString()).data.resource.id));
      v1.ack(message);
    });
    const v1Rebind = setInterval(
      () => void v1.bindQueue(topology.legacy.queue, EVENTS_EXCHANGE, contract.type),
      300,
    );
    const subscription = await consumer(name, (n) => apply(n));
    cleanup.push(() => subscription.cancel());

    for (let n = 0; n < 30; n += 1) {
      await publisher.publishEnvelope(envelope(n));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // The version-1 instance is shut down.
    clearInterval(v1Rebind);
    await v1.close();

    await eventually(() => applied.size === 30);
    expect(duplicates).toBeGreaterThan(0); // both queues received events while both were bound
    expect([...applied.values()].every((c) => c === 1)).toBe(true);

    // Its binding does not outlive it: the version-2 instance unbinds it again within a poll.
    await new Promise((resolve) => setTimeout(resolve, 2 * 2_000 + 500));
    await eventually(async () => (await count(topology.legacy.queue)) === 0);
    await publisher.publishEnvelope(envelope(30));
    await eventually(() => applied.has(30));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await count(topology.legacy.queue)).toBe(0);

    await eventually(async () => (await check(topology.legacy.queue)).consumerCount === 0, 10_000);
    const retired = await retireLegacyQueues(connector, ref(name));
    expect(retired.refused).toBeUndefined();
    expect(retired.retired).toContain(topology.legacy.queue);
  });

  it('rolls back: refuses while version 2 runs; delay-queue messages keep their delay and properties', async () => {
    const name = `it-mig-rollback-${tag}`;
    const DELAY_MS = 3_000;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology, 0);
    const subscription = await subscribe({
      connector,
      service: 'audit-service',
      name,
      contract,
      logger,
      retryDelaysMs: [DELAY_MS, DELAY_MS],
      handler: async () => undefined,
    });
    const rollback = (waitMs: number) => rollBackToLegacy(connector, { ...ref(name), waitMs });

    // Refused while a version-2 consumer is attached; nothing changed.
    const refused = await rollback(1_000);
    expect(refused.refused).toMatch(/consumer/);
    expect((await check(topology.queue)).messageCount).toBe(0);
    await subscription.cancel(); // version-2 instances stopped
    await eventually(async () => (await check(topology.queue)).consumerCount === 0, 10_000);

    const queued = [0, 1, 2].map(envelope);
    for (const e of queued) await publisher.publishEnvelope(e); // in the version-2 main queue
    await eventually(async () => (await count(topology.queue)) === 3);

    // A message in a delay queue, with every property a real one carries.
    const delayed = envelope(3);
    const properties = {
      messageId: delayed.id,
      correlationId: delayed.correlationid,
      type: delayed.type,
      appId: 'issuer-service',
      contentType: 'application/cloudevents+json',
      timestamp: 1_700_000_000,
      headers: {
        [ATTEMPT_HEADER]: 2,
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      },
    };
    const sendChannel = await connector.createConfirmChannel();
    sendChannel.sendToQueue(topology.retryQueues[0]!, Buffer.from(JSON.stringify(delayed)), {
      ...properties,
      persistent: true,
    });
    await sendChannel.waitForConfirms();
    await sendChannel.close();
    const sentAt = Date.now();

    // Short wait: the main-queue messages move; the delayed one is NOT moved early.
    const first = await rollback(500);
    expect(first.refused).toBeUndefined();
    expect(first.moved).toBe(3);
    expect(first.remaining).toEqual([topology.retryQueues[0]]);
    expect(await count(topology.legacy.queue)).toBe(3);
    expect(await count(topology.retryQueues[0]!)).toBe(1);

    // Run again (idempotent): it moves the delayed message once its own delay has passed …
    const second = await rollback(10_000);
    const movedAt = Date.now();
    expect(second).toEqual({ moved: 1, remaining: [] });
    expect(movedAt - sentAt).toBeGreaterThanOrEqual(DELAY_MS - 100);
    // … ready at once in version 1 (no second delay), with everything intact.
    expect(await count(topology.legacy.queue)).toBe(4);
    expect(await rollback(1_000)).toEqual({ moved: 0, remaining: [] }); // repeat: no-op

    const channel = await (await connector.connection()).createChannel();
    const byId = new Map<string, Exclude<Awaited<ReturnType<typeof channel.get>>, false>>();
    for (;;) {
      const message = await channel.get(topology.legacy.queue, { noAck: false });
      if (!message) break;
      byId.set(String(message.properties.messageId), message);
    }
    await channel.close(); // all returned to the queue
    expect(new Set(byId.keys())).toEqual(new Set([...queued, delayed].map((e) => e.id)));
    const moved = byId.get(delayed.id)!;
    expect(JSON.parse(moved.content.toString())).toEqual(delayed);
    expect(moved.properties).toMatchObject({
      messageId: delayed.id,
      correlationId: delayed.correlationid,
      type: delayed.type,
      appId: 'issuer-service',
      contentType: 'application/cloudevents+json',
      timestamp: 1_700_000_000,
      deliveryMode: 2,
    });
    expect(moved.properties.headers?.[ATTEMPT_HEADER]).toBe(2); // retries continue where they were
    expect(moved.properties.headers?.traceparent).toBe(properties.headers.traceparent);
    expect(moved.properties.headers?.['x-death']?.[0]).toMatchObject({
      queue: topology.retryQueues[0],
      reason: 'expired',
    });

    // New events go to version 1 only, and version-1 dead letters have a target.
    await publisher.publishEnvelope(envelope(4));
    await eventually(async () => (await count(topology.legacy.queue)) === 5);
    expect(await count(topology.queue)).toBe(0);
    const dlq = await check(topology.legacy.deadLetterQueue);
    expect(dlq.queue).toBe(topology.legacy.deadLetterQueue);
  });

  it('never confirms-and-drops an internal publish to a missing queue', async () => {
    const name = `it-mig-unroutable-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology, 0);
    let attempts = 0;
    const subscription = await consumer(name, () => {
      attempts += 1;
      throw new Error('failure');
    });
    cleanup.push(() => subscription.cancel());
    // An operator mistake: the first delay queue is deleted under a running consumer.
    const admin = await (await connector.connection()).createChannel();
    await admin.deleteQueue(topology.retryQueues[0]!);
    await admin.close();

    const failing = envelope(1);
    await publisher.publishEnvelope(failing);
    // The retry publish is returned unroutable, so the message is dead-lettered, not lost.
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1);
    expect(attempts).toBe(1);

    // The move tool leaves the source untouched when the target is missing.
    await expect(
      moveMessages(connector, topology.deadLetterQueue, `${topology.base}.does-not-exist`),
    ).rejects.toBeInstanceOf(UnroutableMessageError);
    // Not acknowledged: returned to the source when the tool's channel closed.
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1, 5_000);
  });

  it('keeps dead letters recoverable: reason, history, replay, failing again, idempotency', async () => {
    const name = `it-mig-dlq-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology, 0);
    const applied = new Map<number, number>();
    let duplicates = 0;
    let fixed = false;
    const subscription = await consumer(name, (n) => {
      if (n === 1 && !fixed) throw new Error('poison until fixed');
      if (applied.has(n)) duplicates += 1;
      else applied.set(n, 1);
    });
    cleanup.push(() => subscription.cancel());

    const poison = envelope(1);
    await publisher.publishEnvelope(poison);
    const invalid = randomUUID();
    const raw = await connector.createConfirmChannel();
    raw.publish(EVENTS_EXCHANGE, contract.type, Buffer.from('{"not":"an envelope"}'), {
      messageId: invalid,
      persistent: true,
    });
    await raw.waitForConfirms();
    await raw.close();
    await eventually(async () => (await count(topology.deadLetterQueue)) === 2);

    const browse = async () => {
      const channel = await (await connector.connection()).createChannel();
      const found = new Map<string, Record<string, unknown>>();
      for (;;) {
        const message = await channel.get(topology.deadLetterQueue, { noAck: false });
        if (!message) break;
        found.set(String(message.properties.messageId), {
          ...message.properties.headers,
          correlationId: message.properties.correlationId,
        });
      }
      await channel.close();
      return found;
    };

    // Why it died, from the headers alone: both "rejected" from the main queue; the poison event
    // after its retries (attempt 3, earlier deaths are delay-queue expiries), the invalid
    // envelope at once (attempt 1, no other history).
    let dead = await browse();
    const poisonHeaders = dead.get(poison.id)!;
    expect(poisonHeaders['x-last-death-reason']).toBe('rejected');
    expect(poisonHeaders['x-last-death-queue']).toBe(topology.queue);
    expect(poisonHeaders[ATTEMPT_HEADER]).toBe(3);
    expect((poisonHeaders['x-death'] as { reason: string }[]).map((d) => d.reason).sort()).toEqual([
      'expired',
      'rejected',
    ]);
    const invalidHeaders = dead.get(invalid)!;
    expect(invalidHeaders['x-last-death-reason']).toBe('rejected');
    expect(invalidHeaders[ATTEMPT_HEADER]).toBeUndefined();
    expect((invalidHeaders['x-death'] as unknown[]).length).toBe(1);

    // Replay only the poison event while it still fails: it goes through its retries again and
    // back into the DLQ — still recoverable, id and correlation kept, history kept.
    expect(await replayDeadLetters(connector, ref(name), { messageIds: [poison.id] })).toEqual({
      replayed: 1,
      skipped: 1,
    });
    await eventually(async () => (await browse()).get(poison.id)?.[REPLAY_COUNT_HEADER] === 1);
    dead = await browse();
    expect(dead.size).toBe(2);
    const again = dead.get(poison.id)!;
    expect(again.correlationId).toBe(poison.correlationid);
    expect(again[ATTEMPT_HEADER]).toBe(3);
    const history = JSON.parse(String(again[DEATH_HISTORY_HEADER])) as Record<string, unknown>[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ reason: 'rejected', queue: topology.queue, attempt: 3 });

    // Fixed: replayed again, applied once; the history now has both earlier deaths.
    fixed = true;
    await replayDeadLetters(connector, ref(name), { messageIds: [poison.id] });
    await eventually(() => applied.has(1));
    expect((await browse()).has(poison.id)).toBe(false);

    // Replaying an event that was already applied is absorbed by the idempotent consumer.
    await publisher.publishEnvelope(envelope(2));
    await eventually(() => applied.has(2));
    const replayChannel = await connector.createConfirmChannel();
    replayChannel.sendToQueue(topology.deadLetterQueue, Buffer.from(JSON.stringify(poison)), {
      messageId: poison.id,
      persistent: true,
      headers: { [DEATH_HISTORY_HEADER]: JSON.stringify(history) },
    });
    await replayChannel.waitForConfirms();
    await replayChannel.close();
    await replayDeadLetters(connector, ref(name), { messageIds: [poison.id] });
    await eventually(() => duplicates === 1);
    expect([...applied.values()].every((c) => c === 1)).toBe(true);
    // The invalid envelope was left in place (returned when the replay's channel closed).
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1, 5_000);
    expect((await browse()).has(invalid)).toBe(true);
  });

  it('dead-letters a message whose delivery keeps being interrupted (no infinite loop)', async () => {
    const name = `it-mig-limit-${tag}`;
    const topology = subscriptionTopology('audit-service', name, 2);
    track(topology, 0);
    const subscription = await consumer(name, () => undefined);
    await subscription.cancel(); // declared; delivered below by hand
    const crashing = envelope(1);
    await send(topology.queue, crashing);
    // A consumer that crashes before acknowledging, over and over.
    for (let i = 0; i <= 20; i += 1) {
      const channel = await (await connector.connection()).createChannel();
      await eventually(
        async () => (await channel.get(topology.queue, { noAck: false })) !== false,
        5_000,
      );
      await channel.close();
    }
    await eventually(async () => (await count(topology.deadLetterQueue)) === 1, 10_000);
    const channel = await (await connector.connection()).createChannel();
    const dead = await channel.get(topology.deadLetterQueue, { noAck: true });
    await channel.close();
    expect(dead && dead.properties.messageId).toBe(crashing.id);
    expect(dead && dead.properties.headers?.['x-last-death-reason']).toBe('delivery_limit');
  });
});
