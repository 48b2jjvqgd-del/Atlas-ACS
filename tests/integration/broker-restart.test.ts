import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  activityRecordedV1,
  defineEvent,
  type ActivityRecorded,
  type EventEnvelope,
} from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import {
  buildEnvelope,
  createPostgresConnector,
  createRabbitMqConnector,
  enqueueEvent,
  EventPublisher,
  inScope,
  OutboxRelay,
  replayDeadLetters,
  subscribe,
  systemScope,
  type Subscription,
} from '@atlas/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './database.js';
import { infrastructure } from './env.js';

/**
 * RabbitMQ restart mid-flow (Stage 1A deliverable 9; final review finding F-01; ADR-038).
 *
 * Unlike messaging-resilience.test.ts (which closes client connections), this test restarts the
 * real broker container (`docker compose restart rabbitmq`) while events are
 *   - committed in the PostgreSQL outbox and being relayed (producer side),
 *   - queued in the main quorum queue and not yet delivered (broker side),
 *   - delivered and being handled but not yet acknowledged (in-flight consumer work),
 *   - waiting in a quorum delay queue for a retry, or expiring from it back to the main queue,
 *   - poison (failing every attempt): undergoing retries or being dead-lettered to the DLQ,
 * and keeps committing events while the broker is down. It then requires that
 *   - every committed event that can be handled reaches the consumer, and its side effect is
 *     applied once (redeliveries and deliberately published duplicates are absorbed by the
 *     idempotent handler; delivery itself is at least once, never exactly once),
 *   - every poison event ends up in the dead-letter queue (observable, with its death reason) and
 *     nothing else does, and it is recoverable: replayed after a "fix", it is applied once,
 *   - the consumer resubscribed and the producer recovered (rows that failed during the outage
 *     are published).
 * Before the F-01 fix (classic delay queues, at-most-once dead-lettering) events in a delay queue
 * at the restart were lost; this test reproduced that.
 *
 * It restarts shared infrastructure, so it runs in CI (CI=true) and locally only on request:
 *   ATLAS_BROKER_RESTART_TEST=1 pnpm test:integration tests/integration/broker-restart.test.ts
 * Integration files run one at a time (vitest.config.ts), and this file waits for the broker to be
 * healthy again before it finishes, so later files are unaffected.
 */
const enabled = process.env.CI === 'true' || process.env.ATLAS_BROKER_RESTART_TEST === '1';
const exec = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, '..', '..');

const logger = createLogger({
  service: 'integration',
  version: '0',
  environment: 'test',
  level: 'silent',
});
// Event types allow lowercase letters only in each segment.
const tag = [...randomBytes(6)].map((b) => String.fromCharCode(97 + (b % 26))).join('');
const contract = defineEvent({
  type: `atlas.test.broker-restart-${tag}.v1`,
  dataSchema: activityRecordedV1.dataSchema,
  producers: ['issuer-service'],
  description: 'Integration test event (broker restart)',
});

const HANDLER_MS = 300; // the in-flight window: side effect applied, not yet acknowledged
const PREFETCH = 5;
const RETRY_DELAY_MS = 2_000;
const BATCHES = { beforeRestart: 40, duringRestart: 20, afterRestart: 10 } as const;
const failsOnFirstDelivery = (n: number) => n % 10 === 3;
/** Fails every attempt until "fixed": retried, then dead-lettered. */
const isPoison = (n: number) => n % 10 === 7;
/** Long enough for the broker's at-least-once dead-letter worker to retry after recovery. */
const DELIVERY_TIMEOUT_MS = 240_000;

let db: TestDatabase | undefined;
let restarted = false;
const cleanup: (() => Promise<unknown>)[] = [];

async function compose(...args: string[]) {
  return exec('docker', ['compose', ...args], { cwd: repositoryRoot, timeout: 120_000 });
}

async function brokerHealth(): Promise<string> {
  const { stdout: id } = await compose('ps', '-q', 'rabbitmq');
  if (!id.trim()) return 'missing';
  const { stdout } = await exec('docker', [
    'inspect',
    '--format',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    id.trim(),
  ]);
  return stdout.trim();
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (
      await Promise.resolve()
        .then(check)
        .catch(() => false)
    )
      return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const waitForHealthyBroker = () =>
  eventually(async () => (await brokerHealth()) === 'healthy', 150_000, 'a healthy broker');

const data = (n: number): ActivityRecorded => ({
  occurredAt: new Date().toISOString(),
  actor: { type: 'system', id: 'integration' },
  action: 'test.broker-restart',
  resource: { type: 'test', id: String(n) },
  outcome: 'success',
});

beforeAll(async () => {
  if (!enabled) return;
  // Refuse to start from an unhealthy broker: the test must begin with RabbitMQ healthy.
  await waitForHealthyBroker();
  db = await createTestDatabase('brokerrestart');
}, 180_000);

afterAll(async () => {
  // Whatever happened, leave the broker healthy for the files that run next.
  if (restarted) await waitForHealthyBroker().catch(() => undefined);
  for (const step of cleanup.reverse()) await step().catch(() => undefined);
  await db?.drop();
}, 180_000);

describe.skipIf(!enabled)('RabbitMQ restart mid-flow (real broker container restart)', () => {
  it('loses nothing, applies each side effect once, and resumes producers and consumers', async () => {
    const postgres = createPostgresConnector({
      url: db!.roleUrl('issuer-service'),
      applicationName: 'integration-broker-restart',
      logger,
      tenantContextSchema: 'issuer',
    });
    cleanup.push(() => postgres.close());

    // Separate connections for producer and consumer, as in separate services.
    const producerConnector = createRabbitMqConnector({
      url: infrastructure.rabbitmqUrl,
      connectionName: `restart-producer-${tag}`,
      logger,
    });
    const consumerConnector = createRabbitMqConnector({
      url: infrastructure.rabbitmqUrl,
      connectionName: `restart-consumer-${tag}`,
      logger,
    });
    cleanup.push(
      () => producerConnector.close(),
      () => consumerConnector.close(),
    );

    // ---- Consumer: idempotent (keyed on event id), slow enough to have work in flight.
    const deliveries = new Map<string, number>();
    const sideEffects = new Map<string, number>();
    const failedOnce = new Set<string>();
    let duplicatesAbsorbed = 0;
    let poisonFixed = false;
    const subscription: Subscription = await subscribe({
      connector: consumerConnector,
      service: 'audit-service',
      name: `it-broker-restart-${tag}`,
      contract,
      logger,
      prefetch: PREFETCH,
      retryDelaysMs: [RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS],
      handler: async (event: EventEnvelope<ActivityRecorded>) => {
        deliveries.set(event.id, (deliveries.get(event.id) ?? 0) + 1);
        const n = Number(event.data.resource.id);
        if (isPoison(n) && !poisonFixed) throw new Error('permanent failure: dead-lettered');
        if (failsOnFirstDelivery(n) && !failedOnce.has(event.id)) {
          failedOnce.add(event.id);
          throw new Error('transient failure: goes through the delay queue');
        }
        if (sideEffects.has(event.id)) {
          duplicatesAbsorbed += 1; // a redelivery: the side effect is not applied again
          return;
        }
        sideEffects.set(event.id, (sideEffects.get(event.id) ?? 0) + 1);
        // Acknowledged only after this: a restart now leaves the message unacknowledged.
        await new Promise((resolve) => setTimeout(resolve, HANDLER_MS));
      },
    });
    const allQueues = [
      subscription.queue,
      ...subscription.retryQueues,
      subscription.deadLetterQueue,
    ];
    cleanup.push(async () => {
      await subscription.cancel();
      const channel = await (await consumerConnector.connection()).createChannel();
      for (const queue of allQueues) await channel.deleteQueue(queue).catch(() => undefined);
      await channel.close().catch(() => undefined);
    });

    // ---- Producer: the real transactional outbox relay.
    const relay = new OutboxRelay({
      pool: postgres.pool,
      schema: 'issuer',
      publisher: new EventPublisher(producerConnector, 'issuer-service', { logger }),
      logger,
      intervalMs: 100,
    });
    relay.start();
    cleanup.push(() => relay.stop());

    const committed: string[] = [];
    const envelopes: EventEnvelope[] = [];
    let next = 0;
    const commit = async () => {
      const envelope = buildEnvelope(contract, data(next), {
        service: 'issuer-service',
        correlationId: randomUUID(),
      });
      next += 1;
      await inScope(postgres.pool, systemScope, (client) =>
        enqueueEvent(client, 'issuer', envelope),
      );
      committed.push(envelope.id);
      envelopes.push(envelope);
    };
    const poisonIds = () => committed.filter((_, n) => isPoison(n));
    const handleableIds = () => committed.filter((_, n) => !isPoison(n));

    const sideEffectsDone = () =>
      [...deliveries.keys()].filter((id) => sideEffects.has(id) || failedOnce.has(id)).length;
    const readyCounts = async () => {
      const probe = await (await consumerConnector.connection()).createChannel();
      const main = (await probe.checkQueue(subscription.queue)).messageCount;
      let delay = 0;
      for (const queue of subscription.retryQueues)
        delay += (await probe.checkQueue(queue)).messageCount;
      await probe.close();
      return { main, delay };
    };
    const queueCounts = async () => {
      const counts: Record<string, number | string> = {};
      const probe = await (await consumerConnector.connection()).createChannel();
      probe.on('error', () => undefined);
      for (const queue of allQueues) {
        counts[queue] = await probe
          .checkQueue(queue)
          .then((q) => `${q.messageCount} ready, ${q.consumerCount} consumers`)
          .catch((e: Error) => `unavailable (${e.message.slice(0, 60)})`);
      }
      await probe.close().catch(() => undefined);
      return counts;
    };
    const dlqIds = async (): Promise<Map<string, Record<string, unknown>>> => {
      // Browse without consuming: get everything, then requeue it all.
      const channel = await (await consumerConnector.connection()).createChannel();
      const ids = new Map<string, Record<string, unknown>>();
      for (;;) {
        const message = await channel.get(subscription.deadLetterQueue, { noAck: false });
        if (!message) break;
        ids.set(String(message.properties.messageId), message.properties.headers ?? {});
      }
      await channel.close(); // unacknowledged: all of them return to the queue
      return ids;
    };

    // 1. Healthy broker: commit a batch; the slow consumer builds a backlog in the queue.
    for (let i = 0; i < BATCHES.beforeRestart; i += 1) await commit();
    await eventually(
      () => sideEffects.size >= 8 && failedOnce.size >= 1,
      30_000,
      'consumer work in flight before the restart',
    );
    expect(sideEffects.size).toBeLessThan(BATCHES.beforeRestart); // backlog still queued

    // 2. Restart the real broker while work is queued, in flight and in the delay queue, and keep
    //    committing events while it is down. Snapshot first: proves what the restart interrupted.
    const atRestart = await readyCounts();
    const inFlightAtRestart = deliveries.size - sideEffectsDone();
    restarted = true;
    const restart = compose('restart', '--timeout', '30', 'rabbitmq');
    for (let i = 0; i < BATCHES.duringRestart; i += 1) {
      await commit();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    await restart;
    await waitForHealthyBroker();

    // 3. After recovery, more events.
    for (let i = 0; i < BATCHES.afterRestart; i += 1) await commit();

    const total = BATCHES.beforeRestart + BATCHES.duringRestart + BATCHES.afterRestart;
    const fail = async (error: unknown) => {
      // Say where the missing events are (outbox, queues, delay queues, DLQ) before failing.
      const dead = await dlqIds().catch(() => new Map());
      const diagnostics = {
        committed: committed.length,
        applied: sideEffects.size,
        missing: committed.flatMap((id, n) => (sideEffects.has(id) || dead.has(id) ? [] : [n])),
        deadLettered: committed.flatMap((id, n) => (dead.has(id) ? [n] : [])),
        outboxPending: await relay.pending(),
        generations: subscription.generations,
        duplicatesAbsorbed,
        queues: await queueCounts(),
      };
      throw new Error(`${(error as Error).message}: ${JSON.stringify(diagnostics)}`);
    };
    await eventually(
      () => handleableIds().every((id) => sideEffects.has(id)),
      DELIVERY_TIMEOUT_MS,
      'every handleable committed event to reach the consumer',
    ).catch(fail);
    await eventually(
      async () => {
        const dead = await dlqIds();
        return poisonIds().every((id) => dead.has(id));
      },
      DELIVERY_TIMEOUT_MS,
      'every poison event to reach the dead-letter queue',
    ).catch(fail);
    // Let late redeliveries arrive, so "applied once" is checked after they have.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // ---- Duplicate delivery, deliberately: publish five already-delivered events again (as a
    // relay that stopped between the broker's confirm and its commit would). Absorbed.
    const absorbedBefore = duplicatesAbsorbed;
    const republisher = new EventPublisher(producerConnector, 'issuer-service', { logger });
    const duplicated = envelopes.filter((_, n) => !isPoison(n)).slice(0, 5);
    for (const envelope of duplicated) await republisher.publishEnvelope(envelope);
    await eventually(
      () => duplicatesAbsorbed >= absorbedBefore + duplicated.length,
      30_000,
      'the deliberate duplicates to be delivered and absorbed',
    );

    // Optional per-run record, for repeated runs: ATLAS_BROKER_RESTART_REPORT=<file> (JSON lines).
    if (process.env.ATLAS_BROKER_RESTART_REPORT)
      appendFileSync(
        process.env.ATLAS_BROKER_RESTART_REPORT,
        `${JSON.stringify({
          atRestart: { ...atRestart, inFlightAtRestart },
          duplicatesAbsorbed: absorbedBefore,
          failedOnce: failedOnce.size,
          poison: poisonIds().length,
          generations: subscription.generations,
          committed: committed.length,
        })}\n`,
      );
    // The restart hit every stage: a backlog in the main queue and messages in the delay queues.
    expect(atRestart.main).toBeGreaterThan(0);
    expect(atRestart.delay).toBeGreaterThan(0);

    // No loss, nothing unexpected.
    expect(committed).toHaveLength(total);
    expect(new Set(sideEffects.keys())).toEqual(new Set(handleableIds()));
    // Each side effect applied once, despite redelivery and duplicates.
    expect([...sideEffects.values()].every((count) => count === 1)).toBe(true);
    // The restart really interrupted in-flight work: unacknowledged deliveries came back.
    expect(absorbedBefore).toBeGreaterThan(0);
    // The retry path survived the restart: every event that failed once was delivered again.
    expect(failedOnce.size).toBeGreaterThan(0);
    for (const id of failedOnce) expect(deliveries.get(id) ?? 0).toBeGreaterThanOrEqual(2);
    // The consumer resubscribed after the broker came back.
    expect(subscription.generations).toBeGreaterThanOrEqual(2);

    // The producer saw the outage and recovered: rows failed while the broker was down, and every
    // row is now published.
    const failedDuringOutage = await postgres.pool.query(
      'SELECT count(*)::int AS n FROM issuer.outbox WHERE id = ANY($1) AND last_error IS NOT NULL',
      [committed],
    );
    expect(failedDuringOutage.rows[0].n).toBeGreaterThan(0);
    const unpublished = await postgres.pool.query(
      'SELECT count(*)::int AS n FROM issuer.outbox WHERE id = ANY($1) AND published_at IS NULL',
      [committed],
    );
    expect(unpublished.rows[0].n).toBe(0);
    expect(await relay.pending()).toBe(0);

    // ---- Poison: observable in the DLQ (exactly the poison events, with the broker's death
    // reason), retried a bounded number of times (no loop), and recoverable by replay.
    const dead = await dlqIds();
    expect(new Set(dead.keys())).toEqual(new Set(poisonIds()));
    // Dead-lettered by the broker from the main queue after the last failed attempt (earlier
    // deaths in the history are the delay queues' expiries).
    for (const headers of dead.values()) {
      expect(headers['x-last-death-reason']).toBe('rejected');
      expect(headers['x-last-death-queue']).toBe(subscription.queue);
    }
    for (const id of poisonIds()) {
      // First delivery + three retries; at most a few more from deliveries the restart interrupted.
      expect(deliveries.get(id) ?? 0).toBeGreaterThanOrEqual(4);
      expect(deliveries.get(id) ?? 0).toBeLessThanOrEqual(4 + 2 * PREFETCH);
    }
    poisonFixed = true;
    // Replayed with the operator tool: event id kept, failure history moved into a header.
    const replayed = await replayDeadLetters(consumerConnector, {
      service: 'audit-service',
      name: `it-broker-restart-${tag}`,
      retries: 3,
      routingKey: contract.type,
    });
    expect(replayed.replayed).toBeGreaterThanOrEqual(poisonIds().length);
    await eventually(
      () => poisonIds().every((id) => sideEffects.has(id)),
      30_000,
      'replayed poison events to be applied',
    ).catch(fail);
    expect(new Set(sideEffects.keys())).toEqual(new Set(committed));
    expect([...sideEffects.values()].every((count) => count === 1)).toBe(true);
    expect((await dlqIds()).size).toBe(0);
  }, 600_000);
});
