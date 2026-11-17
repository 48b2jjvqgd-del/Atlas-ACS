-- Owner: identity-service
-- Stage 1A final remediation: a deterministic relay order for the transactional outbox.
--
-- The relay used to pick pending rows ORDER BY created_at. created_at defaults to now(), which is
-- the *start* time of the inserting transaction, so every event written by one transaction had the
-- same value (their relative order was undefined) and a long transaction's events sorted before
-- events that committed earlier. relay_sequence is assigned when the row is inserted, so the relay
-- order is the insertion order of the rows it can see: deterministic, and the order the producer
-- wrote them within a transaction.
--
-- This is NOT a commit-order or cross-instance ordering guarantee (see SECURITY_MODEL.md, "Audit
-- logging", and ADR-037): a transaction that started earlier can still commit, and be relayed,
-- after a later one, and several relay instances publish concurrently.

-- Up Migration
ALTER TABLE identity.outbox ADD COLUMN relay_sequence bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE identity.outbox ADD CONSTRAINT outbox_relay_sequence_unique UNIQUE (relay_sequence);
DROP INDEX identity.outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON identity.outbox (relay_sequence) WHERE published_at IS NULL;
COMMENT ON COLUMN identity.outbox.relay_sequence IS
  'Insertion order; the relay publishes pending rows in this order (best effort, not commit order).';

-- Down Migration
DROP INDEX identity.outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON identity.outbox (next_attempt_at) WHERE published_at IS NULL;
ALTER TABLE identity.outbox DROP CONSTRAINT outbox_relay_sequence_unique;
ALTER TABLE identity.outbox DROP COLUMN relay_sequence;
