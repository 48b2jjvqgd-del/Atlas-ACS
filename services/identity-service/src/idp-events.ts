import type { Logger } from '@atlas/observability';
import { inScope, systemScope, type AuditWriter } from '@atlas/service-kit';
import type pg from 'pg';
import type { IdentityProviderAdmin } from './identity-provider.js';
import * as repo from './repository.js';

/**
 * Ingests failed sign-in attempts from the identity provider's event feed into the audit trail.
 *
 * Password checks happen at the provider, so this is where failed attempts become visible to ATLAS
 * ("where available"). Only the provider's error code and the account id (when the username
 * matched an account) are recorded — never the attempted username or password.
 */
export function startIdpEventIngestion(options: {
  pool: pg.Pool;
  idp: IdentityProviderAdmin;
  logger: Logger;
  audit: AuditWriter;
  intervalMs: number;
}): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;

  const cycle = async () => {
    await inScope(options.pool, systemScope, async (client) => {
      const since = await repo.readEventCursor(client);
      // On first run only look back one hour, to avoid replaying a long history.
      const from = since > 0 ? since : Date.now() - 3_600_000;
      const events = await options.idp.loginErrors(from);
      for (const event of events) {
        const user = event.userId
          ? await client.query<{ id: string; email: string }>(
              'SELECT id, email FROM identity.user_account WHERE idp_subject = $1',
              [event.userId],
            )
          : undefined;
        const account = user?.rows[0];
        await options.audit.record(client, `idp-event-${event.time}`, {
          occurredAt: new Date(event.time).toISOString(),
          actor: account
            ? { type: 'user', id: account.id }
            : { type: 'anonymous', id: 'anonymous' },
          action: 'auth.sign-in.failed',
          resource: account
            ? { type: 'user', id: account.id, name: account.email }
            : { type: 'identity-provider', id: 'sign-in' },
          outcome: 'failure',
          metadata: { error: event.error, client: event.clientId },
        });
      }
      const last = events.at(-1)?.time ?? from;
      await repo.writeEventCursor(client, Math.max(last, since));
      if (events.length > 0)
        options.logger.info({ count: events.length }, 'failed sign-ins recorded');
    });
  };

  const tick = () => {
    if (stopped) return;
    running = cycle()
      .catch((error: unknown) =>
        options.logger.warn(
          { error: { name: (error as Error).name } },
          'identity-provider event ingestion failed',
        ),
      )
      .finally(() => {
        running = undefined;
        if (!stopped) {
          timer = setTimeout(tick, options.intervalMs);
          timer.unref();
        }
      });
  };
  timer = setTimeout(tick, 2_000);
  timer.unref();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
