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
import type { ConfirmChannel, ConsumeMessage, Message, Options } from 'amqplib';
import type { RabbitMqConnector } from './connectors/rabbitmq.js';

/**
 * Asynchronous messaging conventions (RabbitMQ).
 *
 * Topology (queue topology version 2, ADR-038). A subscription <service>.<name> owns:
 *   atlas.events                 durable topic exchange; routing key = event type
 *                                (e.g. atlas.issuer.tenant-created.v1)
 *   atlas.events.dlx             durable topic dead-letter exchange
 *   <service>.<name>.v2          main queue: quorum, owned by exactly one consuming service
 *   <service>.<name>.v2.retry.<n> delay queue for retry attempt n: quorum, fixed TTL, expired
 *                                messages dead-letter back to the main queue
 *   <service>.<name>.v2.dlq      dead-letter queue (quorum, no delivery limit, so inspecting a
 *                                message and returning it can never make the broker drop it):
 *                                messages needing human attention
 *   atlas.events.unrouted        events no queue was bound for (alternate exchange, set by broker
 *                                policy in infrastructure/docker/rabbitmq/definitions.json) — kept,
 *                                never silently discarded
 * The main and delay queues dead-letter at least once ('x-dead-letter-strategy: at-least-once',
 * which RabbitMQ honours only together with 'x-overflow: reject-publish'): a message leaves its
 * queue only after the target queue has confirmed it, so a broker restart cannot drop it on the
 * way. Version 1 (<service>.<name>, classic <service>.<name>.retry.<n> and <service>.<name>.dlq,
 * at-most-once) is unbound and drained by version-2 consumers; see messaging-migration.ts.
 *
 * Guarantees
 *   - Publishers use confirm channels and persistent messages: publish() resolves only once the
 *     broker has accepted the message. Publishing is retried a bounded number of times.
 *   - Payloads are validated against the contract before publishing and after consuming.
 *   - Delivery is at-least-once: consumers must be idempotent, keyed on the event id.
 *   - Order is NOT guaranteed (ADR-037): a consumer handles up to `prefetch` messages concurrently,
 *     retried messages return after later ones, and producers relay concurrently. Consumers must be
 *     order-independent.
 *   - A failing handler is retried with increasing delays (default 1s, 5s, 30s, 2m); after the last
 *     attempt the message is dead-lettered. Contract-invalid messages are dead-lettered at once.
 *     A message whose delivery is interrupted (consumer crash, broker restart) more than
 *     DELIVERY_LIMIT times is dead-lettered by the broker. Nothing is silently dropped and
 *     nothing is requeued in a hot loop.
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
/** Set on a message the consumer moved to the dead-letter queue itself (from a version-1 queue). */
export const DEAD_LETTERED_FROM_HEADER = 'x-atlas-dead-lettered-from';
/** Interrupted deliveries (returned unacknowledged) before the broker dead-letters a message. */
export const DELIVERY_LIMIT = 20;
export const QUEUE_TOPOLOGY_VERSION = 2;

/**
 * Arguments that make a quorum queue dead-letter at least once. RabbitMQ silently falls back to
 * at-most-once unless the overflow behaviour is 'reject-publish' (verified against the broker in
 * tests/integration/messaging-migration.test.ts).
 */
export const AT_LEAST_ONCE_QUORUM_ARGUMENTS = {
  'x-queue-type': 'quorum',
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
} as const;

/** Queue names of one subscription, current (version 2) and legacy (version 1). */
export interface SubscriptionTopology {
  /** "<service>.<name>": the subscription's identity. */
  base: string;
  /** Main queue; also the routing key its dead letters carry on the dead-letter exchange. */
  queue: string;
  retryQueues: readonly string[];
  deadLetterQueue: string;
  legacy: { queue: string; deadLetterQueue: string; retryQueue(retry: number): string };
}

export function subscriptionTopology(
  service: string,
  name: string,
  retries: number,
): SubscriptionTopology {
  const base = `${service}.${name}`;
  const queue = `${base}.v${QUEUE_TOPOLOGY_VERSION}`;
  return {
    base,
    queue,
    retryQueues: Array.from({ length: retries }, (_, index) => `${queue}.retry.${index + 1}`),
    deadLetterQueue: `${queue}.dlq`,
    legacy: {
      queue: base,
      deadLetterQueue: `${base}.dlq`,
      retryQueue: (retry) => `${base}.retry.${retry}`,
    },
  };
}

/** Main-queue arguments of version 2. */
export function mainQueueArguments(topology: SubscriptionTopology): Record<string, unknown> {
  return {
    ...AT_LEAST_ONCE_QUORUM_ARGUMENTS,
    'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
    'x-dead-letter-routing-key': topology.queue,
    'x-delivery-limit': DELIVERY_LIMIT,
  };
}

/**
 * Dead-letter-queue arguments of version 2. Terminal (nothing is dead-lettered from it), and
 * without a delivery limit: RabbitMQ 4 quorum queues default to 20 and then drop the message when
 * there is no dead-letter target, so browsing a dead letter 20 times (get, then requeue) deleted it.
 */
export const DEAD_LETTER_QUEUE_ARGUMENTS = {
  'x-queue-type': 'quorum',
  'x-delivery-limit': -1,
} as const;

/** Delay-queue arguments of version 2: expired messages go straight back to the main queue. */
export function retryQueueArguments(
  topology: SubscriptionTopology,
  delayMs: number,
): Record<string, unknown> {
  return {
    ...AT_LEAST_ONCE_QUORUM_ARGUMENTS,
    'x-message-ttl': delayMs,
    'x-dead-letter-exchange': '',
    'x-dead-letter-routing-key': topology.queue,
  };
}

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
  /** The main (version-2) queue. */
  queue: string;
  deadLetterQueue: string;
  retryQueues: readonly string[];
  /** The version-1 main queue this subscription drains while it exists. */
  legacyQueue: string;
  /** Number of times the consumer has been (re-)established. */
  readonly generations: number;
  /** Whether the version-1 queue still exists and is being watched and drained. */
  readonly drainingLegacyQueue: boolean;
  cancel(): Promise<void>;
}

/** How often a subscription re-checks its version-1 queue while it exists. */
export const LEGACY_POLL_MS = 2_000;

export async function subscribe<T extends z.ZodType>(
  options: SubscriptionOptions<T>,
): Promise<Subscription> {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const topology = subscriptionTopology(options.service, options.name, retryDelays.length);
  const { queue } = topology;
  let cancelled = false;
  let generations = 0;
  let channel: ConfirmChannel | undefined;
  let consumerTag: string | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let backoffMs = 250;
  // Version-1 drain. The version-1 queue is consumed only while it holds messages; the consumer
  // is cancelled once it is empty and no version-1 delivery is unacknowledged. So "no messages
  // and no consumers" on that queue proves nothing is in flight, which retirement relies on.
  let legacyWatched = false;
  let legacyTag: string | undefined;
  let legacyInFlight = 0;
  let legacyTimer: NodeJS.Timeout | undefined;

  const consumeOn = async (on: ConfirmChannel, source: string): Promise<string> =>
    (
      await on.consume(source, (message: ConsumeMessage | null) => {
        if (message) {
          if (source === queue) {
            void handleMessage(on, message, source, topology, retryDelays, options);
            return;
          }
          legacyInFlight += 1;
          void handleMessage(on, message, source, topology, retryDelays, options).finally(() => {
            legacyInFlight -= 1;
          });
          return;
        }
        // Consumer cancelled by the broker (queue deleted).
        if (cancelled || channel !== on) return;
        if (source !== queue) {
          legacyTag = undefined; // the version-1 queue was retired; the next poll stops watching
          return;
        }
        channel = undefined;
        void on.close().catch(() => undefined);
        scheduleSetup();
      })
    ).consumerTag;

  const pollLegacy = async () => {
    const current = channel;
    if (cancelled || !current || !legacyWatched) return;
    // Unbinds it again on every check: a version-1 instance still running re-binds it whenever it
    // resubscribes, and the binding must not outlive it (rolling deployment).
    const state = await adoptLegacyQueue(options.connector, topology, options.contract.type);
    if (channel !== current || cancelled) return;
    if (!state) {
      legacyWatched = false;
      legacyTag = undefined;
      options.logger.info({ queue, legacyQueue: topology.legacy.queue }, 'legacy queue retired');
    } else if (!legacyTag && state.messages > 0) {
      legacyTag = await consumeOn(current, topology.legacy.queue);
    } else if (legacyTag && state.messages === 0 && legacyInFlight <= 0) {
      const tag = legacyTag;
      legacyTag = undefined;
      await current.cancel(tag);
    }
  };

  const watchLegacy = () => {
    if (legacyTimer || cancelled || !legacyWatched) return;
    legacyTimer = setTimeout(() => {
      pollLegacy()
        .catch(() => undefined) // channel trouble: the resubscription re-adopts the queue
        .finally(() => {
          legacyTimer = undefined;
          watchLegacy();
        });
    }, LEGACY_POLL_MS);
    legacyTimer.unref();
  };

  const setup = async () => {
    const next = await options.connector.createConfirmChannel();
    try {
      await assertConsumerTopology(next, topology, options.contract.type, retryDelays);
      // Only after the version-2 queue is bound: a version-1 queue is unbound, then drained.
      const legacy = await adoptLegacyQueue(options.connector, topology, options.contract.type);
      await next.prefetch(options.prefetch ?? 10);
      next.on('error', () => undefined); // reported through 'close'
      next.on('close', () => {
        if (cancelled || channel !== next) return;
        channel = undefined;
        options.logger.warn({ queue }, 'consumer channel closed; resubscribing');
        scheduleSetup();
      });
      const tag = await consumeOn(next, queue);
      const drainTag =
        legacy && legacy.messages > 0 ? await consumeOn(next, topology.legacy.queue) : undefined;
      channel = next;
      consumerTag = tag;
      legacyTag = drainTag;
      legacyWatched = legacy !== undefined;
      generations += 1;
      backoffMs = 250;
      if (legacy) {
        options.logger.info(
          { queue, legacyQueue: topology.legacy.queue, messages: legacy.messages },
          'legacy (version 1) queue unbound; draining it',
        );
        watchLegacy();
      }
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
    deadLetterQueue: topology.deadLetterQueue,
    retryQueues: topology.retryQueues,
    legacyQueue: topology.legacy.queue,
    get generations() {
      return generations;
    },
    get drainingLegacyQueue() {
      return legacyWatched;
    },
    async cancel() {
      cancelled = true;
      clearTimeout(retryTimer);
      clearTimeout(legacyTimer);
      const current = channel;
      channel = undefined;
      if (current) {
        for (const tag of [consumerTag, legacyTag])
          if (tag) await current.cancel(tag).catch(() => undefined);
        await current.close().catch(() => undefined);
      }
    },
  };
}

/** Declares (idempotently) the version-2 topology of a subscription and binds its main queue. */
export async function assertConsumerTopology(
  channel: ConfirmChannel,
  topology: SubscriptionTopology,
  routingKey: string,
  retryDelays: readonly number[],
): Promise<void> {
  await assertEventTopology(channel);
  // Declared and bound first, so the main queue always has a dead-letter target.
  await channel.assertQueue(topology.deadLetterQueue, {
    durable: true,
    arguments: DEAD_LETTER_QUEUE_ARGUMENTS,
  });
  await channel.bindQueue(topology.deadLetterQueue, DEAD_LETTER_EXCHANGE, topology.queue);
  await channel.assertQueue(topology.queue, {
    durable: true,
    arguments: mainQueueArguments(topology),
  });
  // One delay queue per attempt, each with a fixed TTL, so short delays are never stuck behind
  // long ones. Declared before the main queue is bound, so a retry always has somewhere to go.
  for (const [index, delayMs] of retryDelays.entries()) {
    await channel.assertQueue(topology.retryQueues[index]!, {
      durable: true,
      arguments: retryQueueArguments(topology, delayMs),
    });
  }
  await channel.bindQueue(topology.queue, EVENTS_EXCHANGE, routingKey);
}

/**
 * If the subscription's version-1 queue exists, stops routing new events to it and returns its
 * ready-message count. Never deletes or purges it.
 */
async function adoptLegacyQueue(
  connector: RabbitMqConnector,
  topology: SubscriptionTopology,
  routingKey: string,
): Promise<{ messages: number } | undefined> {
  const state = await legacyQueueState(connector, topology);
  if (!state) return undefined;
  const channel = await (await connector.connection()).createChannel();
  try {
    await channel.unbindQueue(topology.legacy.queue, EVENTS_EXCHANGE, routingKey);
  } finally {
    await channel.close().catch(() => undefined);
  }
  return state;
}

/** Ready messages in the version-1 main queue, or undefined if it does not exist. */
async function legacyQueueState(
  connector: RabbitMqConnector,
  topology: SubscriptionTopology,
): Promise<{ messages: number } | undefined> {
  // A missing queue closes the channel (404), so the check gets its own.
  const probe = await (await connector.connection()).createChannel();
  probe.on('error', () => undefined);
  try {
    const { messageCount } = await probe.checkQueue(topology.legacy.queue);
    await probe.close().catch(() => undefined);
    return { messages: messageCount };
  } catch (error) {
    if (/NOT[_-]FOUND|404/.test((error as Error).message)) return undefined;
    throw error;
  }
}

async function handleMessage<T extends z.ZodType>(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  source: string,
  topology: SubscriptionTopology,
  retryDelays: readonly number[],
  options: SubscriptionOptions<T>,
): Promise<void> {
  const attempt = Number(message.properties.headers?.[ATTEMPT_HEADER] ?? 1) || 1;
  const context = {
    messageId: message.properties.messageId as string | undefined,
    correlationId: message.properties.correlationId as string | undefined,
    eventType: options.contract.type,
    queue: source,
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
    await deadLetter(channel, message, source, topology);
    return;
  }

  try {
    await runWithTraceContext(
      message.properties.headers,
      `${options.contract.type} process`,
      {
        'messaging.system': 'rabbitmq',
        'messaging.destination.name': topology.queue,
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
        // Always into the version-2 delay queues, also for a message drained from version 1.
        await sendToQueueConfirmed(channel, topology.retryQueues[attempt - 1]!, message.content, {
          ...message.properties,
          headers: { ...message.properties.headers, [ATTEMPT_HEADER]: attempt + 1 },
        });
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
    await deadLetter(channel, message, source, topology);
  }
}

/**
 * Moves a message to the dead-letter queue. From the version-2 queue the broker does it (reject;
 * at-least-once dead-lettering). A version-1 queue dead-letters at most once, so for a drained
 * message the consumer copies it to the dead-letter queue with a publisher confirm and only then
 * acknowledges it.
 */
async function deadLetter(
  channel: ConfirmChannel,
  message: ConsumeMessage,
  source: string,
  topology: SubscriptionTopology,
): Promise<void> {
  if (source !== topology.queue) {
    try {
      await sendToQueueConfirmed(channel, topology.deadLetterQueue, message.content, {
        ...message.properties,
        headers: { ...message.properties.headers, [DEAD_LETTERED_FROM_HEADER]: source },
      });
      safely(() => channel.ack(message));
      return;
    } catch {
      // Channel closed: not acknowledged, so the broker redelivers it (the reject below is a
      // no-op). Copy refused or unroutable: fall back to the version-1 queue's dead-lettering.
    }
  }
  safely(() => channel.nack(message, false, false));
}

export class UnroutableMessageError extends Error {
  constructor(readonly queue: string) {
    super(`message returned unroutable: queue ${queue} does not exist`);
    this.name = 'UnroutableMessageError';
  }
}

const returnedMessages = new WeakMap<ConfirmChannel, Set<string>>();
const returnKey = (queue: string, messageId: unknown) => `${queue}\u0000${String(messageId)}`;

/**
 * Publishes straight to a queue: persistent, `mandatory`, and confirmed. Resolves only once the
 * queue holds the message. Rejects if the broker refuses it, and also if the queue does not exist:
 * the default exchange then drops the message yet still confirms it, so without `mandatory` a
 * deleted delay or dead-letter queue would silently lose messages that were then acknowledged at
 * their source. RabbitMQ sends the return before the confirm, so it is seen by the time the
 * confirm arrives.
 */
export async function sendToQueueConfirmed(
  channel: ConfirmChannel,
  queue: string,
  content: Buffer,
  properties: Options.Publish,
): Promise<void> {
  let returned = returnedMessages.get(channel);
  if (!returned) {
    const set = new Set<string>();
    returned = set;
    returnedMessages.set(channel, set);
    channel.on('return', (message: Message) =>
      set.add(returnKey(message.fields.routingKey, message.properties.messageId)),
    );
  }
  const key = returnKey(queue, properties.messageId);
  channel.sendToQueue(queue, content, { ...properties, persistent: true, mandatory: true });
  await channel.waitForConfirms();
  if (returned.delete(key)) throw new UnroutableMessageError(queue);
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
