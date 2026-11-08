import { randomBytes, randomUUID } from 'node:crypto';
import { configurationChangedV1, tenantCreatedV1, type EventEnvelope } from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import {
  EVENTS_EXCHANGE,
  EventPublisher,
  createRabbitMqConnector,
  subscribe,
  type Subscription,
} from '@atlas/service-kit';
import { afterAll, describe, expect, it } from 'vitest';
import { infrastructure, withCredentials } from './env.js';

const logger = createLogger({
  service: 'integration',
  version: '0.0.0',
  environment: 'test',
  level: 'silent',
});
const connector = createRabbitMqConnector({
  url: infrastructure.rabbitmqUrl,
  connectionName: 'integration',
  logger,
});
const runId = randomBytes(3).toString('hex');
const queues: string[] = [];

afterAll(async () => {
  const channel = await (await connector.connection()).createChannel();
  for (const queue of queues) {
    await channel.deleteQueue(queue);
    await channel.deleteQueue(`${queue}.dlq`);
  }
  await channel.close();
  await connector.close();
});

function waitFor<T>(
  executor: (resolve: (value: T) => void) => void,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
    executor((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('RabbitMQ connectivity', () => {
  it('passes the readiness check', async () => {
    await expect(connector.check()).resolves.toBeUndefined();
  });

  it('fails the readiness check with wrong credentials', async () => {
    const bad = createRabbitMqConnector({
      url: withCredentials(infrastructure.rabbitmqUrl, 'wrong-password'),
      connectionName: 'integration-bad',
      logger,
    });
    await expect(bad.check()).rejects.toThrow();
    await bad.close();
  });
});

describe('event messaging', () => {
  it('delivers a contract-valid event end to end with envelope metadata', async () => {
    let deliver: (event: EventEnvelope<{ slug: string }>) => void = () => undefined;
    const received = waitFor<EventEnvelope<{ slug: string }>>((resolve) => {
      deliver = resolve;
    });
    // Await the subscription so the queue is declared and bound before anything is published.
    const subscription: Subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-tenant-created-${runId}`,
      contract: tenantCreatedV1,
      logger,
      handler: async (event) => deliver(event),
    });
    queues.push(subscription.queue);

    const correlationId = randomUUID();
    const tenantId = randomUUID();
    const publisher = new EventPublisher(connector, 'issuer-service');
    const published = await publisher.publish(
      tenantCreatedV1,
      { tenantId, slug: 'synthetic-issuer', displayName: 'Synthetic Issuer' },
      { correlationId, tenantId },
    );

    const event = await received;
    expect(event.id).toBe(published.id);
    expect(event).toMatchObject({
      type: 'atlas.issuer.tenant-created.v1',
      source: 'urn:atlas:service:issuer-service',
      correlationid: correlationId,
      tenantid: tenantId,
      data: { slug: 'synthetic-issuer' },
    });
    await subscription.cancel();
  });

  it('refuses to publish an invalid payload, or an event the service does not own', async () => {
    const publisher = new EventPublisher(connector, 'issuer-service');
    await expect(
      publisher.publish(
        tenantCreatedV1,
        { tenantId: 'nope', slug: 'x', displayName: '' },
        { correlationId: randomUUID() },
      ),
    ).rejects.toThrow();
    const wrongProducer = new EventPublisher(connector, 'acs-core');
    await expect(
      wrongProducer.publish(
        tenantCreatedV1,
        { tenantId: randomUUID(), slug: 'abc', displayName: 'x' },
        { correlationId: randomUUID() },
      ),
    ).rejects.toThrow(/not the registered producer/);
  });

  it('dead-letters messages that violate the contract instead of dropping or redelivering them', async () => {
    let handlerCalls = 0;
    const subscription = await subscribe({
      connector,
      service: 'audit-service',
      name: `it-config-changed-${runId}`,
      contract: configurationChangedV1,
      logger,
      handler: async () => {
        handlerCalls += 1;
      },
    });
    queues.push(subscription.queue);

    const channel = await (await connector.connection()).createConfirmChannel();
    channel.publish(
      EVENTS_EXCHANGE,
      configurationChangedV1.type,
      Buffer.from('{"not":"an envelope"}'),
    );
    await channel.waitForConfirms();

    let deadLettered = 0;
    for (let attempt = 0; attempt < 50 && deadLettered === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deadLettered = (await channel.checkQueue(`${subscription.queue}.dlq`)).messageCount;
    }
    await channel.close();
    await subscription.cancel();

    expect(deadLettered).toBe(1);
    expect(handlerCalls).toBe(0);
  });
});
