-- Owner: audit-service
-- Stage 1A: append-only, tamper-evident audit trail.
--
--   * One row per audited action. The row id is the event id, so redelivered events are ignored
--     (idempotent consumption).
--   * Append-only at three levels: the audit-service role has SELECT and INSERT only (roles.ts);
--     triggers reject UPDATE, DELETE and TRUNCATE for every role; the API has no write endpoints.
--   * Tamper evidence: each row's hash covers its content and the previous row's hash in the same
--     chain. There is one chain per issuer and one "platform" chain for platform-level actions.
--   * Row-level security: issuer users see only their issuers' rows; platform rows (tenant_id IS
--     NULL) are visible only with platform-wide scope.

-- Up Migration
CREATE TABLE audit.audit_record (
  id              uuid        PRIMARY KEY,
  sequence        bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  chain           text        NOT NULL,
  occurred_at     timestamptz NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  actor_type      text        NOT NULL,
  actor_id        text        NOT NULL,
  actor_display   text,
  tenant_id       uuid,
  action          text        NOT NULL,
  resource_type   text        NOT NULL,
  resource_id     text        NOT NULL,
  resource_name   text,
  outcome         text        NOT NULL,
  correlation_id  text        NOT NULL,
  source_service  text        NOT NULL,
  changes         jsonb,
  metadata        jsonb,
  reason          text,
  previous_hash   text,
  hash            text        NOT NULL,
  CONSTRAINT audit_record_outcome_valid CHECK (outcome IN ('success', 'failure', 'denied')),
  CONSTRAINT audit_record_actor_type_valid CHECK (actor_type IN ('user', 'service', 'system', 'anonymous')),
  CONSTRAINT audit_record_chain_matches_tenant CHECK (
    (tenant_id IS NULL AND chain = 'platform') OR (tenant_id IS NOT NULL AND chain = tenant_id::text)
  ),
  CONSTRAINT audit_record_hash_format CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX audit_record_chain_idx ON audit.audit_record (chain, sequence DESC);
CREATE INDEX audit_record_tenant_idx ON audit.audit_record (tenant_id, sequence DESC);
CREATE INDEX audit_record_action_idx ON audit.audit_record (action, sequence DESC);
CREATE INDEX audit_record_actor_idx ON audit.audit_record (actor_id, sequence DESC);
CREATE INDEX audit_record_occurred_idx ON audit.audit_record (occurred_at DESC);
CREATE INDEX audit_record_resource_idx ON audit.audit_record (resource_type, resource_id, sequence DESC);

COMMENT ON TABLE audit.audit_record IS 'Append-only audit trail. System of record: audit-service.';

CREATE FUNCTION audit.reject_modification() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit records are append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_record_no_update_delete
  BEFORE UPDATE OR DELETE ON audit.audit_record
  FOR EACH ROW EXECUTE FUNCTION audit.reject_modification();
CREATE TRIGGER audit_record_no_truncate
  BEFORE TRUNCATE ON audit.audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_modification();

CREATE FUNCTION audit.rls_tenant_visible(tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('atlas.scope', true), '') = 'all'
        OR (coalesce(current_setting('atlas.scope', true), '') = 'tenant'
            AND tenant IS NOT NULL
            AND tenant = ANY (coalesce(nullif(current_setting('atlas.tenant_ids', true), ''), '{}')::uuid[]));
  $$;

ALTER TABLE audit.audit_record ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_record_isolation ON audit.audit_record
  FOR SELECT USING (audit.rls_tenant_visible(tenant_id));
-- The consumer records events for every tenant; it writes with platform-wide scope.
CREATE POLICY audit_record_append ON audit.audit_record
  FOR INSERT WITH CHECK (coalesce(current_setting('atlas.scope', true), '') = 'all');

-- Down Migration
DROP POLICY audit_record_append ON audit.audit_record;
DROP POLICY audit_record_isolation ON audit.audit_record;
DROP FUNCTION audit.rls_tenant_visible(uuid);
DROP TRIGGER audit_record_no_truncate ON audit.audit_record;
DROP TRIGGER audit_record_no_update_delete ON audit.audit_record;
DROP FUNCTION audit.reject_modification();
DROP TABLE audit.audit_record;
