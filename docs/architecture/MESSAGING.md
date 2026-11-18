# Messaging reliability: queue topology, migration and recovery

Implementation: [`messaging.ts`](../../packages/service-kit/src/messaging.ts) (topology, consumer),
[`messaging-migration.ts`](../../packages/service-kit/src/messaging-migration.ts) (operator tooling).
Decision: ADR-038 (DECISIONS.md). Conventions: CONVENTIONS.md, "Asynchronous (RabbitMQ)".

## Delivery model

- **At least once, never exactly once.** An event can be delivered more than once: a broker restart or
  consumer crash returns unacknowledged deliveries; the outbox relay publishes again if it stops between
  the broker's confirm and its own commit; at-least-once dead-lettering can copy a message twice if the
  broker restarts between the copy and the removal. Every consumer is **idempotent, keyed on the event
  `id`** (audit-service: `INSERT … ON CONFLICT (id) DO NOTHING` on the event id).
- **No silent loss of a committed event.** Producer side: the row stays in the outbox until the broker
  confirms the publish. Broker side: every queue is a durable quorum queue holding persistent messages,
  and every move between queues (main → delay queue, delay queue → main, main → dead-letter queue) is
  confirmed by the target before the source lets go of the message.
- **Order is not guaranteed** (ADR-037).

## Queue topology (version 2)

For a subscription `<service>.<name>` (the only production one is `audit-service.activity-recorded`):

| Queue                         | Type   | Arguments                                                                                                                                                           | Role                                                  |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `<service>.<name>.v2`         | quorum | `x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`, `x-dead-letter-exchange: atlas.events.dlx`, routing key = queue name, `x-delivery-limit: 20` | Main queue, bound to `atlas.events` by event type     |
| `<service>.<name>.v2.retry.N` | quorum | `at-least-once`, `reject-publish`, `x-message-ttl` = Nth retry delay, `x-dead-letter-exchange: ""` (default exchange), routing key = main queue                     | Delay queue for retry N; expiry returns it to main    |
| `<service>.<name>.v2.dlq`     | quorum | `x-delivery-limit: -1` (no limit)                                                                                                                                   | Dead letters, for people; bound to `atlas.events.dlx` |

How a message moves:

- **Retry.** A failing handler publishes the message to the delay queue for its attempt (persistent,
  with a publisher confirm), and only then acknowledges it. The attempt number travels in
  `x-atlas-attempt`. Delays default to 1 s, 5 s, 30 s, 2 min.
- **Back from a delay queue.** The broker dead-letters the expired message to the main queue, **at least
  once**: it stays in the delay queue until the main queue has confirmed it. This is the F-01 fix.
- **To the dead-letter queue.** After the last attempt, or at once if the envelope fails contract
  validation, the consumer rejects the message; the broker dead-letters it **at least once**. A message
  whose delivery is interrupted more than 20 times (for example a payload that crashes the process)
  is dead-lettered by the broker (`x-delivery-limit`), so it cannot loop forever.

Why each argument matters (each was checked against RabbitMQ 4.4.0, see "Evidence"):

- **Quorum queues** are replicated Raft logs (one replica locally; three in a cluster) and the only
  RabbitMQ queue type that supports at-least-once dead-lettering.
- **`x-dead-letter-strategy: at-least-once`.** The default (at most once) hands the message to the
  target and forgets it; if the target cannot take it — e.g. a quorum queue that has not yet elected a
  leader while the broker is starting — it is dropped without trace. That is how messages in the old
  delay queues were lost on restart.
- **`x-overflow: reject-publish`** is required: with any other overflow behaviour the broker silently
  falls back to at most once, whatever the strategy argument says. No length limit is set, so it never
  rejects anything today; if a limit is added later, publishers get a negative confirm (the outbox
  keeps the row) instead of the queue dropping its oldest message.
- **`x-delivery-limit: -1` on the dead-letter queue.** RabbitMQ 4 quorum queues default to a delivery
  limit of 20; a queue with no dead-letter target then **deletes** the message. A dead letter that was
  inspected and returned 20 times (management UI "Get messages" with requeue, or a script) disappeared.

## Observing and recovering poison messages

Dead letters are in `<service>.<name>.v2.dlq`. Inspecting them is safe (no delivery limit: tested
with 25 inspect-and-return cycles). Every dead-lettering is logged at error level with the event id
and the handler's error, and counted (`atlas_messages_consumed_total{outcome="dead-lettered"}`).

**Why a message is there**, from its headers alone:

| Headers                                                                                          | Cause                                                                   |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `x-last-death-reason: rejected`, `x-atlas-attempt` = retries + 1, `x-death` also lists `expired` | Handler failed on every attempt (see the error log for the event id)    |
| `x-last-death-reason: rejected`, no `x-atlas-attempt`, a single `x-death` entry                  | Envelope failed contract validation on arrival (payload never logged)   |
| `x-last-death-reason: delivery_limit`                                                            | Delivery interrupted 20 times (consumer crash or restarts mid-handling) |
| `x-atlas-dead-lettered-from: <queue>`                                                            | Moved from a version-1 queue by a consumer or the retirement tool       |
| `x-atlas-death-history` (JSON list), `x-atlas-replays: n`                                        | Replayed `n` times before; one entry per earlier dead-lettering         |

**Replay** after the cause is fixed:

```sh
pnpm --filter @atlas/service-kit messaging-topology replay audit-service.activity-recorded \
  [--message-id <event id> ...] [--limit <n>]
```

It moves each selected dead letter to the main queue (confirmed, then acknowledged; unselected ones
stay). Every property is kept: event id (`messageId`), correlation id, type, trace context. The
broker's death headers are moved into `x-atlas-death-history` (when, reason, queue, attempt, `x-death`
summary), because **RabbitMQ 4 starts a new `x-death` history when a message dies again** — copying
`x-death` along would lose it (verified). The attempt counter is reset to 1 (a full set of retries).
A replayed event is an ordinary delivery: if it was already applied, the idempotent consumer ignores
it; if it fails again, it goes through its retries back into the dead-letter queue, recoverable again,
with the earlier failure in its history.

## Supported deployment sequence (version 1 → version 2)

Version 1 (Stage 1A before F-01): main `<service>.<name>` (quorum, at most once), delay queues
`<service>.<name>.retry.N` (**classic**, at most once), dead letters `<service>.<name>.dlq` (quorum,
delivery limit 20). RabbitMQ refuses to change a queue's type or these arguments in place (`406
PRECONDITION_FAILED inequivalent arg`), hence new names.

1. **Roll out version-2 instances** (any order, rolling, with version-1 instances still running).
   Nothing to run by hand. Each version-2 instance, on every (re)subscription:
   1. declares the version-2 queues, then binds the version-2 main queue (from then on every new event
      reaches it, whatever else happens);
   2. **then** unbinds the version-1 main queue, if it exists;
   3. consumes the version-1 main queue while it holds messages. Version-1 delay queues keep expiring
      into it, so they drain through it too. A drained message that fails goes into the version-2
      delay queues; one that must be dead-lettered is copied into the version-2 dead-letter queue
      (confirmed) before it is acknowledged;
   4. every 2 s while the version-1 queue exists: unbinds it again (a version-1 instance re-binds it
      whenever it resubscribes), starts consuming it if it has messages, and stops consuming it once
      it is empty and none of its deliveries is unacknowledged.

   **While both versions run**, an event may reach both main queues and be handled by both versions:
   a duplicate, absorbed by the idempotent consumer (tested: 30 events, version-1 instance re-binding
   every 300 ms, each applied once). Every event always reaches the version-2 queue, so none can be
   routed only to a queue that is about to go away.

2. **Stop the last version-1 instance.** Within one poll its binding is gone.
3. **Wait** at least the longest version-1 retry delay (2 min), so the version-1 delay queues empty.
4. **Check:** `pnpm --filter @atlas/service-kit messaging-topology status` (version-1 queues: 0 ready,
   0 consumers).
5. **Retire:** `pnpm --filter @atlas/service-kit messaging-topology retire`.

Every step can be interrupted and repeated: subscription setup is declare/bind/unbind (idempotent);
`retire` skips what is already gone and refuses rather than guesses; moves copy before they
acknowledge, so an interrupted move leaves at most a duplicate.

### What `retire` does

It **refuses** (exit code 1, nothing deleted) while a version-1 delay queue holds a message, or the
version-1 main queue has ready messages or **any consumer**. A version-2 instance detaches only when
nothing it took from that queue is unacknowledged, so "no consumers" means no unacknowledged message
exists; a remaining consumer is a version-1 instance still running (tested). Quorum queues cannot be
deleted `if-empty` (RabbitMQ closes the connection), which is why this check is needed. Otherwise:

1. unbinds the version-1 main queue (nothing can be routed to it between the checks and its deletion);
2. deletes the version-1 delay queues, highest attempt first (`if-empty`: refused by the broker if a
   message arrived after the check);
3. re-checks and deletes the version-1 main queue;
4. moves every version-1 dead letter into `<service>.<name>.v2.dlq` (history kept as is; marked
   `x-atlas-dead-lettered-from`), then deletes the emptied version-1 dead-letter queue.

A second run reports nothing to do. Nothing is purged.

## Rollback to version-1 code

1. **Stop all version-2 instances** (scale audit-service to zero). `rollback` refuses while the
   version-2 main queue has a consumer.
2. `pnpm --filter @atlas/service-kit messaging-topology rollback`:
   1. declares the version-1 dead-letter queue and its binding, and the version-1 main queue (exact
      version-1 arguments, re-created if retired), and binds it **before** unbinding the version-2 main
      queue: no moment at which an event reaches neither, and version-1 dead letters have a target;
   2. moves every message of the version-2 main queue into the version-1 main queue;
   3. waits for the version-2 delay queues. Their messages are **not** moved early and get no new
      delay: each waits out its own remaining delay in its version-2 delay queue, expires into the
      version-2 main queue, is moved, and is ready at once in version 1 (tested with a 3 s delay: moved
      no earlier than 3 s after it was delayed, ready immediately). It finishes when the delay queues
      are empty **and** a final pass moved nothing (a message can expire between the two checks).
      It keeps every property and header: event id, correlation id, type, app id, timestamp, content
      type, trace context, and `x-atlas-attempt`, so a retried message continues with its next attempt
      under version 1 (tested). If `--wait-ms` (default 2 min 10 s, longer than the longest delay) runs
      out first, it lists the delay queues still waiting and exits 1: **run it again** — until then those
      messages wait in version-2 queues, not lost, but not consumed by version-1 code.
3. Deploy the version-1 code.

Duplicates: a move interrupted between copy and acknowledgement copies a message twice; both versions
are idempotent. Loss: none, provided step 1 is respected (enforced) and step 2 is run until it exits 0. The version-2 queues stay in place, empty and unbound; `<service>.<name>.v2.dlq` keeps its dead
letters (version-1 code does not read dead-letter queues). Rolling back reintroduces the F-01 loss
window. Rolling forward again needs no action.

## Internal publishes cannot be lost to a missing queue

Retries, consumer-side dead-letter copies, moves and replays publish straight to a queue through the
default exchange. If that queue had been deleted, the broker would drop the message **and still
confirm it**, and the source message would then be acknowledged: lost. Every such publish is therefore
`mandatory`: an unroutable message comes back (before the confirm) and the publish fails. A failed
retry falls back to dead-lettering; a failed move or replay leaves the source message where it was
(tested by deleting a delay queue under a running consumer).

## Recovery after a broker restart

No action needed. Producers keep committing to their outboxes while the broker is down; the relay
publishes when it is back. Consumers' channels close; each subscription re-establishes itself with
back-off (250 ms doubling to 10 s) and re-declares its topology. Unacknowledged deliveries come back
(duplicates, absorbed). Messages that expired in delay queues during the outage are moved to the main
queue once it has a leader. If that first attempt fails, the broker retries it after its dead-letter
publisher-confirm timeout (`dead_letter_worker_publisher_confirm_timeout`, 3 min by default), so
recovery of those messages can take a few minutes; they are not lost.

## Evidence

- `tests/integration/broker-restart.test.ts` restarts the real RabbitMQ container with events in the
  outbox, in the main queue, in flight, in the delay queues and on their way to the dead-letter queue,
  and while new events are committed; it asserts no loss, each side effect applied once,
  resubscription, outbox recovery, every poison event in the dead-letter queue with its death reason,
  and replay with the operator tool. It reproduced the version-1 loss (two events in a delay queue
  lost) before the fix. Runs in CI (`CI=true`); locally with `ATLAS_BROKER_RESTART_TEST=1`.
- `tests/integration/messaging-migration.test.ts`: broker-held arguments; dead letters survive
  inspection; drain of version-1 main, delay queues and poison; coexistence of both versions;
  retirement refusals (messages, consumers), success and repetition; rollback refusal, delay
  preservation, property preservation, repetition; unroutable internal publishes; dead-letter causes,
  replay that fails again, replay after a fix, replay of an applied event; the delivery limit.
- Verified directly against RabbitMQ 4.4.0 while designing (not automated, because the broker retries
  only after its 3-minute confirm timeout): a delay queue whose dead-letter target did not exist
  **kept** the expired message with `at-least-once` + `reject-publish` and delivered it once the target
  appeared; with the default strategy, or with `at-least-once` but without `reject-publish`, the
  message was dropped.

## Limitations

- **Single broker node locally.** Quorum queues on one node survive a restart (data is on disk, fsynced
  before the confirm) but not the loss of the volume. Production needs a three-node cluster (Stage 7).
- **Duplicates are possible**, by design; consumers must stay idempotent.
- **Recovery latency.** See "Recovery after a broker restart": up to the broker's 3-minute confirm
  timeout for messages expiring during recovery.
- **Ready counts only.** Tools see ready messages, not unacknowledged ones; retirement relies on the
  consumer-count rule above, and rollback on version-2 instances being stopped (enforced). A message
  held by the broker's at-least-once dead-letter worker (expired, target briefly unavailable) is not
  counted as ready for that moment; rollback's final pass catches messages that arrive in the main
  queue, but one still held when it finishes would arrive in the unbound version-2 main queue:
  run `status` after a rollback and run `rollback` again if that queue is not empty.
- **Rollback** returns to at-most-once dead-lettering (the F-01 defect) until version 2 is redeployed,
  and needs to be re-run if it times out (above).
- **Delivery limit.** A message interrupted 20 times is dead-lettered rather than retried further; a
  long series of broker restarts during one delivery could therefore dead-letter a healthy message. It
  is kept and can be replayed.
- **Replay loses broker-native `x-death` counting** across replays by design of RabbitMQ 4; the history
  is preserved in `x-atlas-death-history` instead.
