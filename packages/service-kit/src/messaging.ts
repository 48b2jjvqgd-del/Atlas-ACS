import { randomUUID } from 'node:crypto';
import {
  parseEvent,
  type EventContract,
  type EventEnvelope,
  type ServiceName,
} from '@atlas/contracts';
import type { Logger } from '@atlas/observability';
import type { z } from '@atlas/schemas';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { RabbitMqConnector } from './connectors/rabbitmq.js';

/**
 * Asynchronous messaging conventions (RabbitMQ).
 *
 * Topology
 *   atlas.events       durable topic exchange; routing key = event type
 *                      (e.g. atlas.issuer.tenant-created.v1)
 *   atlas.events.dlx   durable fanout dead-letter exchange
 *   <service>.<name>   durable quorum queue owned by exactly one consuming service
 *   <queue>.dlq        its dead-letter queue
 *
 * Guarantees
 *   - Publishers use confirm channels and persistent messages: publish() resolves only once
 *     the broker has accepted the message.
 *   - Payloads are validated against the contract before publishing and after consuming.
 *   - Delivery is at-least-once: consumers must be idempotent, keyed on the event id.
 *   - Messages that fail validation or handling are dead-lettered, never silently dropped
 *     and never requeued in a hot loop. Retry with back-off is planned for Stage 1A.
 *
 * Messaging is for notifications and eventual consistency (audit, reporting, projections).
 * It is NOT used inside the synchronous EMV 3DS AReq/ARes or CReq/CRes path.
 */
export const EVENTS_EXCHANGE = 'atlas.events';
export const DEAD_LETTER_EXCHANGE = 'atlas.events.dlx';
export const CLOUD_EVENTS_CONTENT_TYPE = 'application/cloudevents+json';

export async function assertEventTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
}

export interface PublishOptions {
  correlationId: string;
  tenantId?: string;
}

export class EventPublisher {
  #channel: Promise<ConfirmChannel> | undefined;

  constructor(
    private readonly connector: RabbitMqConnector,
    private readonly service: ServiceName,
  ) {}

  async publish<T extends z.ZodType>(
    contract: EventContract<T>,
    data: z.input<T>,
    options: PublishOptions,
  ): Promise<EventEnvelope<z.infer<T>>> {
    if (contract.producer !== this.service) {
      throw new Error(`${this.service} is not the registered producer of ${contract.type}`);
    }
    const envelope: EventEnvelope<z.infer<T>> = {
      specversion: '1.0',
      id: randomUUID(),
      source: `urn:atlas:service:${this.service}`,
      type: contract.type,
      time: new Date().toISOString(),
      datacontenttype: 'application/json',
      dataschema: contract.schemaUri,
      correlationid: options.correlationId,
      ...(options.tenantId ? { tenantid: options.tenantId } : {}),
      data: contract.dataSchema.parse(data),
    };
    // Validate the complete envelope with the same function consumers use.
    parseEvent(contract, envelope);

    const channel = await this.channel();
    channel.publish(EVENTS_EXCHANGE, contract.type, Buffer.from(JSON.stringify(envelope)), {
      persistent: true,
      contentType: CLOUD_EVENTS_CONTENT_TYPE,
      messageId: envelope.id,
      correlationId: envelope.correlationid,
      type: envelope.type,
      appId: this.service,
      timestamp: Math.floor(Date.now() / 1000),
    });
    await channel.waitForConfirms();
    return envelope;
  }

  private channel(): Promise<ConfirmChannel> {
    this.#channel ??= this.connector
      .createConfirmChannel()
      .then(async (channel) => {
        channel.on('close', () => {
          this.#channel = undefined;
        });
        await assertEventTopology(channel);
        return channel;
      })
      .catch((error: unknown) => {
        this.#channel = undefined;
        throw error;
      });
    return this.#channel;
  }
}

export interface SubscriptionOptions<T extends z.ZodType> {
  connector: RabbitMqConnector;
  service: ServiceName;
  /** Short purpose name; the queue is "<service>.<name>". */
  name: string;
  contract: EventContract<T>;
  logger: Logger;
  prefetch?: number;
  handler: (event: EventEnvelope<z.infer<T>>) => Promise<void>;
}

export interface Subscription {
  queue: string;
  cancel(): Promise<void>;
}

export async function subscribe<T extends z.ZodType>(
  options: SubscriptionOptions<T>,
): Promise<Subscription> {
  const queue = `${options.service}.${options.name}`;
  const deadLetterQueue = `${queue}.dlq`;
  const channel = await options.connector.createConfirmChannel();
  await assertEventTopology(channel);

  await channel.assertQueue(deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(deadLetterQueue, DEAD_LETTER_EXCHANGE, queue);
  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': queue,
    },
  });
  await channel.bindQueue(queue, EVENTS_EXCHANGE, options.contract.type);
  await channel.prefetch(options.prefetch ?? 10);

  const consumer = await channel.consume(queue, (message: ConsumeMessage | null) => {
    if (!message) return;
    void handleMessage(channel, message, options);
  });

  return {
    queue,
    async cancel() {
      await channel.cancel(consumer.consumerTag);
      await channel.close();
    },
  };
}

async function handleMessage<T extends z.ZodType>(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  options: SubscriptionOptions<T>,
): Promise<void> {
  const context = {
    messageId: message.properties.messageId,
    correlationId: message.properties.correlationId,
    eventType: options.contract.type,
  };
  let event: EventEnvelope<z.infer<T>>;
  try {
    event = parseEvent(options.contract, JSON.parse(message.content.toString('utf8')));
  } catch {
    // Never log the payload: it failed validation, so its content is unknown and untrusted.
    options.logger.warn(context, 'event rejected: contract validation failed; dead-lettered');
    channel.nack(message, false, false);
    return;
  }
  try {
    await options.handler(event);
    channel.ack(message);
  } catch (error) {
    options.logger.error({ ...context, error }, 'event handler failed; dead-lettered');
    channel.nack(message, false, false);
  }
}
