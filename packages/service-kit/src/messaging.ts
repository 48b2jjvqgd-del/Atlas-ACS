import { randomUUID } from 'node:crypto';
import {
  parseEvent,
  type EventContract,
  type EventEnvelope,
  type ServiceName,
} from '@atlas/contracts';
import {
  injectTraceContext,
  runWithTraceContext,
  type Logger,
  type ServiceMetrics,
} from '@atlas/observability';
import type { z } from '@atlas/schemas';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { RabbitMqConnector } from './connectors/rabbitmq.js';

/**
 * Asynchronous messaging conventions (RabbitMQ).
 *
 * Topology
 *   atlas.events            durable topic exchange; routing key = event type
 *                           (e.g. atlas.issuer.tenant-created.v1)
 *   atlas.events.dlx        durable topic dead-letter exchange
 *   <service>.<name>        durable quorum queue owned by exactly one consuming service
 *   <queue>.retry.<n>       delay queue for retry attempt n (fixed TTL, dead-letters back to <queue>)
 *   <queue>.dlq             dead-letter queue: messages needing human attention
 *   atlas.events.unrouted   events no queue was bound for (alternate exchange, set by broker
 *                           policy in infrastructure/docker/rabbitmq/definitions.json) — kept,
 *                           never silently discarded
 *
 * Guarantees
 *   - Publishers use confirm channels and persistent messages: publish() resolves only once the
 *     broker has accepted the message. Publishing is retried a bounded number of times.
 *   - Payloads are validated against the contract before publishing and after consuming.
 *   - Delivery is at-least-once: consumers must be idempotent, keyed on the event id.
 *   - A failing handler is retried with increasing delays (default 1s, 5s, 30s, 2m); after the last
 *     attempt the message is dead-lettered. Contract-invalid messages are dead-lettered at once.
 *     Nothing is silently dropped and nothing is requeued in a hot loop.
 *   - Subscriptions re-establish themselves after a channel or connection loss (with back-off),
 *     and the connector reconnects on demand.
 *   - W3C trace context travels in message headers, so a trace continues into consumers.
 *
 * Messaging is for notifications and eventual consistency (audit, reporting, projections).
 * It is NOT used inside the synchronous EMV 3DS AReq/ARes or CReq/CRes path.
 */
export const EVENTS_EXCHANGE = 'atlas.events';
export const DEAD_LETTER_EXCHANGE = 'atlas.events.dlx';
export const CLOUD_EVENTS_CONTENT_TYPE = 'application/cloudevents+json';
export const ATTEMPT_HEADER = 'x-atlas-attempt';
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000];

export async function assertEventTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
}

export interface PublishOptions {
  correlationId: string;
  tenantId?: string;
}

/** Builds a validated CloudEvents envelope (used directly and by the transactional outbox). */
export function buildEnvelope<T extends z.ZodType>(
  contract: EventContract<T>,
  data: z.input<T>,
  options: PublishOptions & { service: ServiceName; id?: string },
): EventEnvelope<z.infer<T>> {
  if (!contract.producers.includes(options.service)) {
    throw new Error(`${options.service} is not a registered producer of ${contract.type}`);
  }
  const envelope: EventEnvelope<z.infer<T>> = {
    specversion: '1.0',
    id: options.id ?? randomUUID(),
    source: `urn:atlas:service:${options.service}`,
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
  return envelope;
}

export class EventPublisher {
  #channel: Promise<ConfirmChannel> | undefined;

  constructor(
    private readonly connector: RabbitMqConnector,
    private readonly service: ServiceName,
    private readonly options: { attempts?: number; logger?: Logger } = {},
  ) {}

  async publish<T extends z.ZodType>(
    contract: EventContract<T>,
    data: z.input<T>,
    options: PublishOptions,
  ): Promise<EventEnvelope<z.infer<T>>> {
    if (!contract.producers.includes(this.service)) {
      throw new Error(`${this.service} is not the registered producer of ${contract.type}`);
    }
    const envelope = buildEnvelope(contract, data, { ...options, service: this.service });
    await this.publishEnvelope(envelope, injectTraceContext());
    return envelope;
  }

  /** Publishes an already-built envelope (e.g. from the outbox), with bounded retry. */
  async publishEnvelope(
    envelope: EventEnvelope,
    traceHeaders: Record<string, string> = {},
  ): Promise<void> {
    const attempts = this.options.attempts ?? 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const channel = await this.channel();
        channel.publish(EVENTS_EXCHANGE, envelope.type, Buffer.from(JSON.stringify(envelope)), {
          persistent: true,
          contentType: CLOUD_EVENTS_CONTENT_TYPE,
          messageId: envelope.id,
          correlationId: envelope.correlationid,
          type: envelope.type,
          appId: this.service,
          timestamp: Math.floor(Date.now() / 1000),
          headers: { ...traceHeaders },
        });
        await channel.waitForConfirms();
        return;
      } catch (error) {
        this.#channel = undefined;
        if (attempt >= attempts) throw error;
        this.options.logger?.warn(
          { eventType: envelope.type, attempt, error: { name: (error as Error).name } },
          'publish failed; retrying',
        );
        await delay(100 * 2 ** attempt);
      }
    }
  }

  private channel(): Promise<ConfirmChannel> {
    this.#channel ??= this.connector
      .createConfirmChannel()
      .then(async (channel) => {
        channel.on('close', () => {
          this.#channel = undefined;
        });
        channel.on('error', () => {
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
  /** Delay before each retry attempt; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
  metrics?: ServiceMetrics;
  handler: (event: EventEnvelope<z.infer<T>>) => Promise<void>;
}

export interface Subscription {
  queue: string;
  /** Number of times the consumer has been (re-)established. */
  readonly generations: number;
  cancel(): Promise<void>;
}

export async function subscribe<T extends z.ZodType>(
  options: SubscriptionOptions<T>,
): Promise<Subscription> {
  const queue = `${options.service}.${options.name}`;
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let cancelled = false;
  let generations = 0;
  let channel: ConfirmChannel | undefined;
  let consumerTag: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let backoffMs = 250;

  const setup = async () => {
    const next = await options.connector.createConfirmChannel();
    try {
      await assertConsumerTopology(next, queue, options.contract.type, retryDelays);
      await next.prefetch(options.prefetch ?? 10);
      next.on('error', () => undefined); // reported through 'close'
      next.on('close', () => {
        if (cancelled || channel !== next) return;
        channel = undefined;
        options.logger.warn({ queue }, 'consumer channel closed; resubscribing');
        scheduleSetup();
      });
      const consumer = await next.consume(queue, (message: ConsumeMessage | null) => {
        if (!message) {
          // Consumer cancelled by the broker (e.g. queue deleted): resubscribe.
          if (!cancelled) scheduleSetup();
          return;
        }
        void handleMessage(next, message, queue, retryDelays, options);
      });
      channel = next;
      consumerTag = consumer.consumerTag;
      generations += 1;
      backoffMs = 250;
      if (generations > 1)
        options.logger.info({ queue, generation: generations }, 'consumer resubscribed');
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }
  };

  const scheduleSetup = () => {
    if (cancelled || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      setup().catch((error: unknown) => {
        options.logger.warn(
          { queue, retryInMs: backoffMs, error: { name: (error as Error).name } },
          'resubscribe failed; will retry',
        );
        backoffMs = Math.min(backoffMs * 2, 10_000);
        scheduleSetup();
      });
    }, backoffMs);
    retryTimer.unref();
  };

  await setup();

  return {
    queue,
    get generations() {
      return generations;
    },
    async cancel() {
      cancelled = true;
      clearTimeout(retryTimer);
      const current = channel;
      channel = undefined;
      if (current && consumerTag) {
        await current.cancel(consumerTag).catch(() => undefined);
        await current.close().catch(() => undefined);
      }
    },
  };
}

async function assertConsumerTopology(
  channel: ConfirmChannel,
  queue: string,
  routingKey: string,
  retryDelays: readonly number[],
): Promise<void> {
  await assertEventTopology(channel);
  const deadLetterQueue = `${queue}.dlq`;
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
  await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKey);
  // One delay queue per attempt, each with a fixed TTL, so short delays are never stuck behind
  // long ones. Expired messages dead-letter through the default exchange straight back to <queue>.
  for (const [index, delayMs] of retryDelays.entries()) {
    await channel.assertQueue(retryQueueName(queue, index + 1), {
      durable: true,
      arguments: {
        'x-message-ttl': delayMs,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': queue,
      },
    });
  }
}

export function retryQueueName(queue: string, retry: number): string {
  return `${queue}.retry.${retry}`;
}

async function handleMessage<T extends z.ZodType>(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  queue: string,
  retryDelays: readonly number[],
  options: SubscriptionOptions<T>,
): Promise<void> {
  const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 1) || 1;
  const context = {
    messageId: message.properties.messageId as string | undefined,
    correlationId: message.properties.correlationId as string | undefined,
    eventType: options.contract.type,
    attempt,
  };
  const count = (outcome: string) =>
    options.metrics?.messagesConsumed.inc({ event_type: options.contract.type, outcome });

  let event: EventEnvelope<z.infer<T>>;
  try {
    event = parseEvent(options.contract, JSON.parse(message.content.toString('utf8')));
  } catch {
    // Never log the payload: it failed validation, so its content is unknown and untrusted.
    options.logger.warn(context, 'event rejected: contract validation failed; dead-lettered');
    count('dead-lettered');
    safely(() => channel.nack(message, false, false));
    return;
  }

  try {
    await runWithTraceContext(
      message.properties.headers,
      `${options.contract.type} process`,
      {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': queue,
        'messaging.message.id': event.id,
        'atlas.correlation_id': event.correlationid,
      },
      () => options.handler(event),
    );
    safely(() => channel.ack(message));
    count('acked');
  } catch (error) {
    if (attempt <= retryDelays.length) {
      try {
        channel.sendToQueue(retryQueueName(queue, attempt), message.content, {
          ...message.properties,
          persistent: true,
          headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1 },
        });
        await channel.waitForConfirms();
        safely(() => channel.ack(message));
        count('retried');
        options.logger.warn(
          { ...context, retryInMs: retryDelays[attempt - 1], error },
          'event handler failed; scheduled for retry',
        );
        return;
      } catch (retryError) {
        options.logger.error({ ...context, error: retryError }, 'could not schedule retry');
      }
    }
    options.logger.error({ ...context, error }, 'event handler failed; dead-lettered');
    count('dead-lettered');
    safely(() => channel.nack(message, false, false));
  }
}

/** Acks/nacks on a closed channel throw; the broker will redeliver, which is safe (idempotency). */
function safely(action: () => void): void {
  try {
    action();
  } catch {
    /* channel closed: message will be redelivered */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
