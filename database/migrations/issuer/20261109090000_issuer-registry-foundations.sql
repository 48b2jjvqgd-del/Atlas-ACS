-- Owner: issuer-service
-- Stage 1A: issuer administration and tenant isolation.
--   * internal reference on each issuer
--   * versioned, immutable issuer configuration documents
--   * transactional outbox for audit events
--   * row-level security as defence in depth (see SECURITY_MODEL.md, "Tenant isolation")
--
-- Row-level security model (identical in every tenant-owned schema):
--   The service sets two transaction-local settings before touching tenant data:
--     atlas.scope       'all'    — platform-wide access, decided by the service's authorisation
--                       'tenant' — only the tenants listed in atlas.tenant_ids
--     atlas.tenant_ids  '{uuid,uuid}' — PostgreSQL array literal
--   With neither set, no tenant rows are visible. Service roles are not table owners, so policies
--   always apply to them.

-- Up Migration
ALTER TABLE issuer.tenant ADD COLUMN internal_reference text;
ALTER TABLE issuer.tenant ADD CONSTRAINT tenant_internal_reference_key UNIQUE (internal_reference);
ALTER TABLE issuer.tenant ADD CONSTRAINT tenant_internal_reference_format
  CHECK (internal_reference IS NULL OR internal_reference ~ '^[A-Z0-9][A-Z0-9-]{1,39}$');
COMMENT ON COLUMN issuer.tenant.internal_reference IS 'Operator-assigned reference, unique. Not an authorisation key.';

CREATE FUNCTION issuer.rls_tenant_visible(tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('atlas.scope', true), '') = 'all'
        OR (coalesce(current_setting('atlas.scope', true), '') = 'tenant'
            AND tenant = ANY (coalesce(nullif(current_setting('atlas.tenant_ids', true), ''), '{}')::uuid[]));
  $$;
COMMENT ON FUNCTION issuer.rls_tenant_visible(uuid) IS 'Row-level security predicate; see migration header.';

ALTER TABLE issuer.tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON issuer.tenant
  USING (issuer.rls_tenant_visible(id))
  WITH CHECK (issuer.rls_tenant_visible(id));

CREATE TABLE issuer.tenant_configuration (
  tenant_id   uuid        NOT NULL REFERENCES issuer.tenant (id) ON DELETE RESTRICT,
  version     integer     NOT NULL,
  settings    jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text        NOT NULL,
  PRIMARY KEY (tenant_id, version),
  CONSTRAINT tenant_configuration_version_positive CHECK (version > 0),
  CONSTRAINT tenant_configuration_settings_object CHECK (jsonb_typeof(settings) = 'object')
);
COMMENT ON TABLE issuer.tenant_configuration IS
  'Immutable issuer configuration versions; the highest version is current. Validated by issuerSettingsSchema.';

CREATE FUNCTION issuer.reject_modification() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not permitted: rows are immutable', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER tenant_configuration_immutable
  BEFORE UPDATE OR DELETE ON issuer.tenant_configuration
  FOR EACH ROW EXECUTE FUNCTION issuer.reject_modification();

ALTER TABLE issuer.tenant_configuration ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_configuration_isolation ON issuer.tenant_configuration
  USING (issuer.rls_tenant_visible(tenant_id))
  WITH CHECK (issuer.rls_tenant_visible(tenant_id));

-- Transactional outbox: events are inserted in the same transaction as the change they describe
-- and relayed to RabbitMQ afterwards, so a change cannot commit without its audit event.
CREATE TABLE issuer.outbox (
  id            uuid        PRIMARY KEY,
  event_type    text        NOT NULL,
  envelope      jsonb       NOT NULL,
  traceparent   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON issuer.outbox (next_attempt_at) WHERE published_at IS NULL;
COMMENT ON TABLE issuer.outbox IS 'Transactional outbox. Rows are relayed to RabbitMQ and then marked published.';

-- Down Migration
DROP TABLE issuer.outbox;
DROP POLICY tenant_configuration_isolation ON issuer.tenant_configuration;
DROP TABLE issuer.tenant_configuration;
DROP FUNCTION issuer.reject_modification();
DROP POLICY tenant_isolation ON issuer.tenant;
ALTER TABLE issuer.tenant DISABLE ROW LEVEL SECURITY;
DROP FUNCTION issuer.rls_tenant_visible(uuid);
ALTER TABLE issuer.tenant DROP CONSTRAINT tenant_internal_reference_format;
ALTER TABLE issuer.tenant DROP CONSTRAINT tenant_internal_reference_key;
ALTER TABLE issuer.tenant DROP COLUMN internal_reference;
