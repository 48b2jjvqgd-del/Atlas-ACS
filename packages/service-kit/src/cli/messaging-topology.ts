/**
 * Queue-topology tooling (ADR-038; procedure in docs/architecture/MESSAGING.md).
 *
 * Usage (RABBITMQ_URL from the environment or the repository .env):
 *   pnpm --filter @atlas/service-kit messaging-topology status   [subscription]
 *   pnpm --filter @atlas/service-kit messaging-topology retire   [subscription]
 *   pnpm --filter @atlas/service-kit messaging-topology rollback [subscription] [--wait-ms <n>]
 *   pnpm --filter @atlas/service-kit messaging-topology replay   <subscription>
 *                                                [--message-id <id> ...] [--limit <n>]
 *
 * [subscription] defaults to every production subscription below (replay requires one). Every
 * command is safe to repeat. Exit code 1 means "refused or not finished: read the output".
 */
import { activityRecordedV1 } from '@atlas/contracts';
import { createLogger } from '@atlas/observability';
import { createRabbitMqConnector } from '../connectors/rabbitmq.js';
import { DEFAULT_RETRY_DELAYS_MS } from '../messaging.js';
import {
  inspectTopology,
  replayDeadLetters,
  retireLegacyQueues,
  rollBackToLegacy,
  type SubscriptionRef,
} from '../messaging-migration.js';

/** Every production subscription (see the services' subscribe() calls). */
const SUBSCRIPTIONS: SubscriptionRef[] = [
  {
    service: 'audit-service',
    name: 'activity-recorded',
    retries: DEFAULT_RETRY_DELAYS_MS.length,
    routingKey: activityRecordedV1.type,
  },
];
const COMMANDS = ['status', 'retire', 'rollback', 'replay'];

const [command = 'status', ...rest] = process.argv.slice(2);
const options = new Map<string, string[]>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i]!;
  if (arg.startsWith('--')) {
    options.set(arg, [...(options.get(arg) ?? []), rest[i + 1] ?? '']);
    i += 1;
  } else positional.push(arg);
}
const option = (name: string) => options.get(name)?.[0];
const waitMs = Number(option('--wait-ms') ?? 2 * 60_000 + 10_000);
const targets = positional.length
  ? SUBSCRIPTIONS.filter((s) => positional.includes(`${s.service}.${s.name}`))
  : command === 'replay'
    ? []
    : SUBSCRIPTIONS;

const url = process.env.RABBITMQ_URL;
if (!url) {
  console.error('RABBITMQ_URL is not set');
  process.exit(2);
}
if (targets.length === 0 || !COMMANDS.includes(command)) {
  const names = SUBSCRIPTIONS.map((s) => `${s.service}.${s.name}`).join('|');
  console.error(`usage: messaging-topology ${COMMANDS.join('|')} [${names}]`);
  process.exit(2);
}

const connector = createRabbitMqConnector({
  url,
  connectionName: 'messaging-topology-cli',
  logger: createLogger({ service: 'cli', version: '0', environment: 'cli', level: 'silent' }),
});
let failed = false;
try {
  for (const target of targets) {
    const label = `${target.service}.${target.name}`;
    if (command === 'retire') {
      const result = await retireLegacyQueues(connector, target);
      failed ||= Boolean(result.refused);
      console.log(label, result.refused ? `REFUSED (${result.refused})` : 'retired', {
        retired: result.retired,
        deadLettersMoved: result.deadLettersMoved,
      });
    } else if (command === 'rollback') {
      const result = await rollBackToLegacy(connector, { ...target, waitMs });
      failed ||= Boolean(result.refused) || result.remaining.length > 0;
      console.log(
        label,
        result.refused
          ? `REFUSED (${result.refused})`
          : `moved ${result.moved}; ${
              result.remaining.length
                ? `still waiting: ${result.remaining.join(', ')} (run again)`
                : 'version-2 queues empty'
            }`,
      );
    } else if (command === 'replay') {
      const limit = option('--limit');
      const result = await replayDeadLetters(connector, target, {
        ...(options.has('--message-id') ? { messageIds: options.get('--message-id')! } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      });
      console.log(label, `replayed ${result.replayed}, left in place ${result.skipped}`);
    }
    console.table(await inspectTopology(connector, target));
  }
} finally {
  await connector.close();
}
process.exit(failed ? 1 : 0);
