import { randomBytes, randomUUID } from 'node:crypto';
import { activityRecordedV1, type ActivityRecorded, type EventEnvelope } from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import {
  createRabbitMqConnector,
  EventPublisher,
  subscribe,
  type Subscription,
} from '@atlas/service-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { infrastructure } from './env.js';

/**
 * RabbitMQ resilience: automatic reconnection and resubscription, controlled retry with back-off,
 * dead-lettering after the last attempt, and idempotent processing of redelivered events.
 * Connection loss is simulated by closing the client's connections through the management API.
 */
const logger = createLogger({
  service: 'integration',
  version: '0.0.0',
  environment: 'test',
  level: 'silent',
});
const runId = randomBytes(3).toString('hex');
const amqp = new URL(infrastructure.rabbitmqUrl);
const management = `http://${amqp.hostname}:${process.env.RABBITMQ_MANAGEMENT_PORT ?? '15672'}/api`;
const auth = `Basic ${Buffer.from(`${decodeURIComponent(amqp.username)}:${decodeURIComponent(amqp.password)}`).toString('base64')}`;
const cleanup: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
});

async function closeConnections(connectionName: string): Promise<number> {
  // The management API lists new connections after a short delay.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const closed = await closeListed(connectionName);
    if (closed > 0) return closed;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return 0;
}

async function closeListed(connectionName: string): Promise<number> {
  const connections = (await (
    await fetch(`${management}/connections`, { headers: { authorization: auth } })
  ).json()) as {
    name: string;
    client_properties?: { connection_name?: string };
  }[];
  const ours = connections.filter((c) => c.client_properties?.connection_name === connectionName);
  for (const connection of ours) {
    await fetch(`${management}/connections/${encodeURIComponent(connection.name)}`, {
      method: 'DELETE',
      headers: { authorization: auth, 'x-reason': 'integration test: simulated broker outage' },
    });
  }
  return ours.length;
}

const event = (n: number): ActivityRecorded => ({
  occurredAt: new Date().toISOString(),
  actor: { type: 'system', id: 'integration' },
  action: 'test.resilience',
  resource: { type: 'test', id: String(n) },
  outcome: 'success',
});

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function setup(name: string) {
  const connectionName = `integration-${name}-${runId}`;
  const connector = createRabbitMqConnector({
    url: infrastructure.rabbitmqUrl,
    connectionName,
    logger,
  });
  const publisher = new EventPublisher(connector, 'issuer-service', { logger });
  cleanup.push(() => connector.close());
  return { connector, publisher, connectionName };
}

async function deleteQueues(connector: ReturnType<typeof setup>['connector'], queue: string) {
  const channel = await (await connector.connection()).createChannel();
  for (const suffix of ['', '.dlq', '.retry.1', '.retry.2', '.retry.3'])
    await channel.deleteQueue(`${queue}${suffix}`).catch(() => undefined);
  await channel.close().catch(() => undefined);
}

describe('RabbitMQ resilience', () => {
  it('reconnects and resubscribes after the connection is lost, then keeps consuming', async () => {
    const { connector, publisher, connectionName } = setup('reconnect');
    const received: string[] = [];
    const subscription: Subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-reconnect-${runId}`,
      contract: activityRecordedV1,
      logger,
      handler: async (e) => void received.push(e.data.resource.id),
    });
    cleanup.push(async () => {
      await subscription.cancel();
      await deleteQueues(connector, subscription.queue);
    });

    await publisher.publish(activityRecordedV1, event(1), { correlationId: randomUUID() });
    await eventually(() => received.includes('1'));

    expect(await closeConnections(connectionName)).toBeGreaterThan(0);
    // The publisher reconnects on its next publish; the subscription re-establishes itself.
    await publisher.publish(activityRecordedV1, event(2), { correlationId: randomUUID() });
    await eventually(() => received.includes('2'));
    expect(subscription.generations).toBeGreaterThanOrEqual(2);
  });

  it('retries a failing handler with back-off, then succeeds without loss', async () => {
    const { connector, publisher } = setup('retry');
    let attempts = 0;
    const subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-retry-${runId}`,
      contract: activityRecordedV1,
      logger,
      retryDelaysMs: [200, 400, 800],
      handler: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient failure');
      },
    });
    cleanup.push(async () => {
      await subscription.cancel();
      await deleteQueues(connector, subscription.queue);
    });
    const started = Date.now();
    await publisher.publish(activityRecordedV1, event(3), { correlationId: randomUUID() });
    await eventually(() => attempts === 3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(600); // 200 ms + 400 ms of back-off
  });

  it('dead-letters an event that keeps failing after the last retry, without hot-looping', async () => {
    const { connector, publisher } = setup('dlq');
    let attempts = 0;
    const subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-dlq-${runId}`,
      contract: activityRecordedV1,
      logger,
      retryDelaysMs: [100, 100],
      handler: async () => {
        attempts += 1;
        throw new Error('permanent failure');
      },
    });
    cleanup.push(async () => {
      await subscription.cancel();
      await deleteQueues(connector, subscription.queue);
    });
    await publisher.publish(activityRecordedV1, event(4), { correlationId: randomUUID() });
    const channel = await (await connector.connection()).createChannel();
    await eventually(
      async () => (await channel.checkQueue(`${subscription.queue}.dlq`)).messageCount === 1,
    );
    await channel.close();
    expect(attempts).toBe(3); // first delivery + two retries
  });

  it('processes a redelivered event once (idempotent consumer keyed on event id)', async () => {
    const { connector, publisher } = setup('idempotent');
    const processed = new Set<string>();
    let sideEffects = 0;
    const subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-idempotent-${runId}`,
      contract: activityRecordedV1,
      logger,
      handler: async (e: EventEnvelope<ActivityRecorded>) => {
        if (processed.has(e.id)) return;
        processed.add(e.id);
        sideEffects += 1;
      },
    });
    cleanup.push(async () => {
      await subscription.cancel();
      await deleteQueues(connector, subscription.queue);
    });
    const envelope = await publisher.publish(activityRecordedV1, event(5), {
      correlationId: randomUUID(),
    });
    await publisher.publishEnvelope(envelope); // at-least-once delivery: the same event again
    await eventually(() => sideEffects === 1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sideEffects).toBe(1);
  });
});
