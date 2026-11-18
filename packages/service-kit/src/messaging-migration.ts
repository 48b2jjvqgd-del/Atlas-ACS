import type { Channel, MessagePropertyHeaders, XDeath } from 'amqplib';
import type { RabbitMqConnector } from './connectors/rabbitmq.js';
import {
  ATTEMPT_HEADER,
  DEAD_LETTER_EXCHANGE,
  DEAD_LETTER_QUEUE_ARGUMENTS,
  DEAD_LETTERED_FROM_HEADER,
  EVENTS_EXCHANGE,
  QUEUE_TOPOLOGY_VERSION,
  sendToQueueConfirmed,
  subscriptionTopology,
  type SubscriptionTopology,
} from './messaging.js';

/**
 * Operator tooling for the queue-topology migration from version 1 to version 2 (ADR-038).
 *
 * Version 1 (until Stage 1A final remediation F-01):
 *   <base>              quorum main queue, dead-letters at most once to atlas.events.dlx/<base>
 *   <base>.retry.<n>    classic delay queues, dead-letter at most once to <base>
 *   <base>.dlq          quorum, default delivery limit (20)
 * Version 2:
 *   <base>.v2           quorum main queue, at-least-once dead-lettering to atlas.events.dlx/<base>.v2
 *   <base>.v2.retry.<n> quorum delay queues, at-least-once dead-lettering to <base>.v2
 *   <base>.v2.dlq       quorum, no delivery limit
 *
 * Migration is automatic: a version-2 consumer binds <base>.v2, then unbinds <base> and consumes it
 * until it is empty; version-1 delay queues keep expiring into <base>, so they drain through it.
 * Nothing here deletes a queue that holds messages or purges anything; messages are moved with a
 * publisher confirm before they are acknowledged at the source (at least once).
 *
 *   inspectTopology       what exists, with message and consumer counts
 *   retireLegacyQueues    once the version-1 delay and main queues are empty: deletes them, moves
 *                         the version-1 dead letters into <base>.v2.dlq and deletes <base>.dlq
 *   rollBackToLegacy      for a return to version-1 code: rebinds <base>, unbinds <base>.v2 and moves
 *                         every version-2 message into <base>
 *   replayDeadLetters     returns dead letters to <base>.v2 after a fix, keeping their failure history
 */
export interface SubscriptionRef {
  service: string;
  name: string;
  /** Number of retry attempts (delay queues) the subscription is declared with. */
  retries: number;
  /** The event type the subscription is bound to. */
  routingKey: string;
}

/** Failure history kept across replays (the broker restarts `x-death` when a message dies again). */
export const DEATH_HISTORY_HEADER = 'x-atlas-death-history';
export const REPLAY_COUNT_HEADER = 'x-atlas-replays';
const BROKER_DEATH_HEADERS = [
  'x-death',
  'x-first-death-reason',
  'x-first-death-queue',
  'x-first-death-exchange',
  'x-last-death-reason',
  'x-last-death-queue',
  'x-last-death-exchange',
];

export interface QueueState {
  queue: string;
  version: 1 | 2;
  role: 'main' | 'retry' | 'dead-letter';
  exists: boolean;
  /** Ready messages (excludes unacknowledged deliveries). */
  messages: number;
  consumers: number;
}

/** Version-1 delay queues were numbered from 1 without gaps; stop at the first missing one. */
const MAX_LEGACY_RETRY_QUEUES = 32;

async function queueState(
  connector: RabbitMqConnector,
  queue: string,
): Promise<{ exists: boolean; messages: number; consumers: number }> {
  // A missing queue closes the channel (404), so each check gets its own.
  const channel = await (await connector.connection()).createChannel();
  channel.on('error', () => undefined);
  try {
    const { messageCount, consumerCount } = await channel.checkQueue(queue);
    await channel.close().catch(() => undefined);
    return { exists: true, messages: messageCount, consumers: consumerCount };
  } catch (error) {
    if (/NOT[_-]FOUND|404/.test((error as Error).message))
      return { exists: false, messages: 0, consumers: 0 };
    throw error;
  }
}

async function legacyRetryQueues(
  connector: RabbitMqConnector,
  topology: SubscriptionTopology,
): Promise<QueueState[]> {
  const states: QueueState[] = [];
  for (let retry = 1; retry <= MAX_LEGACY_RETRY_QUEUES; retry += 1) {
    const queue = topology.legacy.retryQueue(retry);
    const state = await queueState(connector, queue);
    if (!state.exists) break;
    states.push({ queue, version: 1, role: 'retry', ...state });
  }
  return states;
}

export async function inspectTopology(
  connector: RabbitMqConnector,
  ref: SubscriptionRef,
): Promise<QueueState[]> {
  const topology = subscriptionTopology(ref.service, ref.name, ref.retries);
  const entries: Omit<QueueState, 'exists' | 'messages' | 'consumers'>[] = [
    { queue: topology.queue, version: QUEUE_TOPOLOGY_VERSION as 2, role: 'main' },
    ...topology.retryQueues.map((queue) => ({
      queue,
      version: 2 as const,
      role: 'retry' as const,
    })),
    { queue: topology.deadLetterQueue, version: 2, role: 'dead-letter' },
    { queue: topology.legacy.queue, version: 1, role: 'main' },
    { queue: topology.legacy.deadLetterQueue, version: 1, role: 'dead-letter' },
  ];
  const states: QueueState[] = [];
  for (const entry of entries)
    states.push({ ...entry, ...(await queueState(connector, entry.queue)) });
  return [...states, ...(await legacyRetryQueues(connector, topology))];
}

/**
 * Moves every ready message from one queue to another: copied with a publisher confirm (and
 * `mandatory`: a missing target fails the move), and only then acknowledged at the source.
 * Interrupted, a message may be copied twice, never lost.
 */
export async function moveMessages(
  connector: RabbitMqConnector,
  from: string,
  to: string,
  headers: Record<string, unknown> = {},
): Promise<number> {
  const channel = await connector.createConfirmChannel();
  let moved = 0;
  try {
    for (;;) {
      const message = await channel.get(from, { noAck: false });
      if (!message) return moved;
      // Every property is carried over (message id, correlation id, type, app id, timestamp,
      // content type, headers including x-atlas-attempt, x-death and trace context). If the
      // target is missing the copy is returned and the source message is left unacknowledged.
      await sendToQueueConfirmed(channel, to, message.content, {
        ...message.properties,
        headers: { ...message.properties.headers, ...headers },
      });
      channel.ack(message);
      moved += 1;
    }
  } finally {
    await channel.close().catch(() => undefined);
  }
}

export interface RetirementResult {
  retired: string[];
  /** Version-1 dead letters moved into the version-2 dead-letter queue. */
  deadLettersMoved: number;
  /** Set when retirement stopped, with the reason. */
  refused?: string;
}

/**
 * Retires the version-1 queues of a subscription. Refuses unless
 *   - every version-1 delay queue is empty (deleted `ifEmpty`, which classic queues support, so a
 *     message arriving after the check makes the broker refuse), and
 *   - the version-1 main queue has no ready messages and no consumers. Quorum queues do not
 *     support `ifEmpty`, and a queue check counts ready messages only; but a version-2 consumer
 *     consumes it only while it holds messages and cancels once none of its deliveries is
 *     unacknowledged, so "no consumers" means nothing is in flight. A consumer that remains is
 *     a version-1 consumer still deployed (it would also re-create the queues).
 * It first unbinds the version-1 main queue (a version-1 instance may have re-bound it), so nothing
 * is routed to it between the checks and the deletion. Then it moves the version-1 dead letters into
 * the version-2 dead-letter queue (confirmed, then acknowledged) and deletes the emptied version-1
 * one. Safe to repeat: each step skips what is already done. Run it once the longest version-1
 * retry delay has passed since the last version-1 instance stopped.
 */
export async function retireLegacyQueues(
  connector: RabbitMqConnector,
  ref: SubscriptionRef,
): Promise<RetirementResult> {
  const topology = subscriptionTopology(ref.service, ref.name, ref.retries);
  const refuse = (reason: string, retired: string[] = [], deadLettersMoved = 0) => ({
    retired,
    deadLettersMoved,
    refused: reason,
  });
  let main = await queueState(connector, topology.legacy.queue);
  if (main.exists) {
    // Nothing must be routed to it between the checks below and its deletion.
    const unbind = await (await connector.connection()).createChannel();
    await unbind.unbindQueue(topology.legacy.queue, EVENTS_EXCHANGE, ref.routingKey);
    await unbind.close();
    main = await queueState(connector, topology.legacy.queue);
  }
  const retries = await legacyRetryQueues(connector, topology);
  const busy = [
    ...retries.filter((state) => state.messages > 0).map((state) => state.queue),
    ...(main.messages > 0 ? [topology.legacy.queue] : []),
  ];
  if (busy.length > 0) return refuse(`not empty: ${busy.join(', ')}`);
  if (main.consumers > 0)
    return refuse(`${topology.legacy.queue} still has ${main.consumers} consumer(s)`);

  const retired: string[] = [];
  let deadLettersMoved = 0;
  const channel = await (await connector.connection()).createChannel();
  channel.on('error', () => undefined);
  try {
    // Highest attempt first: a later delay queue never expires into an already deleted one.
    for (const state of [...retries].reverse()) {
      await channel.deleteQueue(state.queue, { ifEmpty: true });
      retired.push(state.queue);
    }
    if (main.exists) {
      // Re-checked now that nothing can expire into it any more.
      const again = await queueState(connector, topology.legacy.queue);
      if (again.messages > 0 || again.consumers > 0)
        return refuse(`${topology.legacy.queue} received messages; run again`, retired);
      await channel.deleteQueue(topology.legacy.queue);
      retired.push(topology.legacy.queue);
    }
    // Nothing dead-letters into the version-1 DLQ any more: move its contents, then delete it.
    const deadLetters = await queueState(connector, topology.legacy.deadLetterQueue);
    if (deadLetters.exists) {
      if (deadLetters.consumers > 0)
        return refuse(`${topology.legacy.deadLetterQueue} has consumers`, retired);
      await channel.assertQueue(topology.deadLetterQueue, {
        durable: true,
        arguments: DEAD_LETTER_QUEUE_ARGUMENTS,
      });
      deadLettersMoved = await moveMessages(
        connector,
        topology.legacy.deadLetterQueue,
        topology.deadLetterQueue,
        { [DEAD_LETTERED_FROM_HEADER]: topology.legacy.deadLetterQueue },
      );
      const left = await queueState(connector, topology.legacy.deadLetterQueue);
      if (left.messages > 0 || left.consumers > 0)
        return refuse(
          `${topology.legacy.deadLetterQueue} not empty; run again`,
          retired,
          deadLettersMoved,
        );
      await channel.deleteQueue(topology.legacy.deadLetterQueue);
      retired.push(topology.legacy.deadLetterQueue);
    }
  } catch (error) {
    return refuse(
      `broker refused: ${(error as Error).message.slice(0, 200)}`,
      retired,
      deadLettersMoved,
    );
  } finally {
    await channel.close().catch(() => undefined);
  }
  return { retired, deadLettersMoved };
}

export interface RollbackResult {
  moved: number;
  /** Version-2 queues still holding messages when the wait ran out (run again later). */
  remaining: string[];
  /** Set when nothing was done, with the reason. */
  refused?: string;
}

/**
 * Prepares a return to version-1 consumers. Refuses while <base>.v2 has consumers (version-2
 * instances still running would keep consuming it and re-binding it). Then, in this order:
 *   1. declares <base>.dlq and its binding, and <base> (exact version-1 arguments), and binds <base>
 *      before unbinding <base>.v2, so there is no moment at which an event is routed to neither and
 *      a version-1 dead letter always has a target;
 *   2. moves every message of <base>.v2 into <base> (confirmed, then acknowledged; all properties
 *      and headers kept, including the attempt counter, so retries continue where they were);
 *   3. waits for the version-2 delay queues: their messages are NOT moved early. Each stays until
 *      its own remaining delay has passed, expires into <base>.v2 and is then moved, ready at once
 *      (its delay is over; it gets no new delay). It finishes only when the delay queues are empty
 *      and a final pass over <base>.v2 moved nothing, or when `waitMs` runs out: then `remaining`
 *      lists what is still waiting; run it again (idempotent) — until then those messages wait in
 *      version-2 queues, not lost but not consumed.
 * At least once: interrupted between a copy and its acknowledgement, a message is copied twice and
 * the idempotent consumer absorbs it. The version-2 queues are left in place, empty and unbound;
 * so is <base>.v2.dlq with its dead letters (handled by operators, not by version-1 code).
 */
export async function rollBackToLegacy(
  connector: RabbitMqConnector,
  ref: SubscriptionRef & { waitMs: number },
): Promise<RollbackResult> {
  const topology = subscriptionTopology(ref.service, ref.name, ref.retries);
  const current = await queueState(connector, topology.queue);
  if (current.consumers > 0)
    return {
      moved: 0,
      remaining: [],
      refused: `${topology.queue} still has ${current.consumers} consumer(s): stop version-2 instances first`,
    };
  const connection = await connector.connection();
  const setupChannel: Channel = await connection.createChannel();
  await setupChannel.assertQueue(topology.legacy.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await setupChannel.bindQueue(
    topology.legacy.deadLetterQueue,
    DEAD_LETTER_EXCHANGE,
    topology.base,
  );
  await setupChannel.assertQueue(topology.legacy.queue, {
    durable: true,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': topology.base,
    },
  });
  await setupChannel.bindQueue(topology.legacy.queue, EVENTS_EXCHANGE, ref.routingKey);
  if (current.exists)
    await setupChannel.unbindQueue(topology.queue, EVENTS_EXCHANGE, ref.routingKey);
  await setupChannel.close();
  if (!current.exists) return { moved: 0, remaining: [] };

  let moved = 0;
  const deadline = Date.now() + ref.waitMs;
  for (;;) {
    moved += await moveMessages(connector, topology.queue, topology.legacy.queue);
    const waiting: string[] = [];
    for (const queue of topology.retryQueues)
      if ((await queueState(connector, queue)).messages > 0) waiting.push(queue);
    if (waiting.length === 0) {
      // A delay queue may have expired a message into <base>.v2 after the pass above.
      const late = await moveMessages(connector, topology.queue, topology.legacy.queue);
      moved += late;
      if (late === 0) return { moved, remaining: [] };
      continue;
    }
    if (Date.now() > deadline) return { moved, remaining: waiting };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export interface ReplayResult {
  replayed: number;
  /** Dead letters left in place (not selected). */
  skipped: number;
}

/**
 * Returns dead letters to the subscription's main queue after the cause has been fixed. Every
 * property is kept (event id, correlation id, type, trace context). The broker's death headers are
 * moved into DEATH_HISTORY_HEADER (a JSON list, one entry per replay: when, why, from which queue,
 * at which attempt, the full x-death summary), because RabbitMQ starts a new x-death history when a
 * replayed message dies again. The attempt counter is reset (a full set of retries) and
 * REPLAY_COUNT_HEADER incremented. A replayed event is an ordinary delivery: the idempotent consumer
 * ignores one it has already applied, and one that fails again goes through the retries and back
 * into the dead-letter queue, still recoverable, with its history.
 * `messageIds` limits the replay to those events; the others stay in the dead-letter queue.
 */
export async function replayDeadLetters(
  connector: RabbitMqConnector,
  ref: SubscriptionRef,
  options: { messageIds?: readonly string[]; limit?: number } = {},
): Promise<ReplayResult> {
  const topology = subscriptionTopology(ref.service, ref.name, ref.retries);
  const wanted = options.messageIds ? new Set(options.messageIds) : undefined;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const channel = await connector.createConfirmChannel();
  let replayed = 0;
  let skipped = 0;
  try {
    while (replayed < limit) {
      const message = await channel.get(topology.deadLetterQueue, { noAck: false });
      if (!message) break;
      if (wanted && !wanted.has(String(message.properties.messageId))) {
        skipped += 1; // left unacknowledged: returned when the channel closes (no delivery limit)
        continue;
      }
      await sendToQueueConfirmed(channel, topology.queue, message.content, {
        ...message.properties,
        headers: replayHeaders(message.properties.headers ?? {}),
      });
      channel.ack(message);
      replayed += 1;
    }
  } finally {
    await channel.close().catch(() => undefined);
  }
  return { replayed, skipped };
}

function replayHeaders(headers: MessagePropertyHeaders): MessagePropertyHeaders {
  const previous = (() => {
    try {
      const parsed: unknown = JSON.parse(String(headers[DEATH_HISTORY_HEADER] ?? '[]'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const deaths: XDeath[] = Array.isArray(headers['x-death']) ? headers['x-death'] : [];
  const entry = {
    replayedAt: new Date().toISOString(),
    reason: headers['x-last-death-reason'] ?? headers['x-first-death-reason'] ?? null,
    queue: headers['x-last-death-queue'] ?? null,
    deadLetteredFrom: headers[DEAD_LETTERED_FROM_HEADER] ?? null,
    attempt: headers[ATTEMPT_HEADER] ?? null,
    deaths: deaths.map((death) => ({
      queue: death.queue,
      reason: death.reason,
      count: death.count,
    })),
  };
  const kept = Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => !BROKER_DEATH_HEADERS.includes(key) && key !== DEAD_LETTERED_FROM_HEADER,
    ),
  );
  return {
    ...kept,
    [ATTEMPT_HEADER]: 1,
    [REPLAY_COUNT_HEADER]: Number(headers[REPLAY_COUNT_HEADER] ?? 0) + 1,
    [DEATH_HISTORY_HEADER]: JSON.stringify([...previous, entry]),
  };
}
