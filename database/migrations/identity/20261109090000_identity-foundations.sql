-- Owner: identity-service
-- Stage 1A: ATLAS users, roles, permissions and issuer memberships.
--
-- Keycloak (or any OIDC provider) authenticates users; this schema is the system of record for what
-- an authenticated user may do. Users are linked to the IdP by subject (the token "sub" claim).
-- Passwords are never stored here.
--
-- Row-level security on tenant memberships follows the model described in the issuer migration:
-- atlas.scope = 'all' | 'tenant', atlas.tenant_ids = '{uuid,...}'.

-- Up Migration
CREATE TABLE identity.role (
  key          text        PRIMARY KEY,
  scope        text        NOT NULL,
  name         text        NOT NULL,
  description  text        NOT NULL DEFAULT '',
  is_system    boolean     NOT NULL DEFAULT false,
  permissions  text[]      NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_key_format CHECK (key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(key) BETWEEN 2 AND 63),
  CONSTRAINT role_scope_valid CHECK (scope IN ('platform', 'tenant')),
  CONSTRAINT role_key_scope_key UNIQUE (key, scope)
);
COMMENT ON TABLE identity.role IS
  'Roles. System roles are synchronised from the contracts catalogue at service start and are read-only.';

-- System role keys are stable identifiers. Their permissions are synchronised by identity-service
-- from packages/contracts/src/authz.ts; a unit test keeps this list and the catalogue identical.
INSERT INTO identity.role (key, scope, name, is_system) VALUES
  ('platform-super-admin',    'platform', 'Platform Super Admin',    true),
  ('platform-administrator',  'platform', 'Platform Administrator',  true),
  ('technical-administrator', 'platform', 'Technical Administrator', true),
  ('issuer-administrator',    'tenant',   'Issuer Administrator',    true),
  ('fraud-manager',           'tenant',   'Fraud Manager',           true),
  ('fraud-analyst',           'tenant',   'Fraud Analyst',           true),
  ('compliance-officer',      'tenant',   'Compliance Officer',      true),
  ('operations-manager',      'tenant',   'Operations Manager',      true),
  ('customer-support',        'tenant',   'Customer Support',        true),
  ('reporting-user',          'tenant',   'Reporting User',          true);

CREATE TABLE identity.user_account (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  idp_subject      text        UNIQUE,
  email            text        NOT NULL,
  display_name     text        NOT NULL,
  status           text        NOT NULL DEFAULT 'invited',
  is_synthetic     boolean     NOT NULL DEFAULT false,
  last_sign_in_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_account_status_valid CHECK (status IN ('invited', 'active', 'disabled')),
  CONSTRAINT user_account_email_format CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT user_account_display_name_length CHECK (length(display_name) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX user_account_email_key ON identity.user_account (email);
COMMENT ON COLUMN identity.user_account.idp_subject IS 'OIDC "sub" of the linked identity-provider account.';

CREATE FUNCTION identity.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER user_account_set_updated_at BEFORE UPDATE ON identity.user_account
  FOR EACH ROW EXECUTE FUNCTION identity.set_updated_at();
CREATE TRIGGER role_set_updated_at BEFORE UPDATE ON identity.role
  FOR EACH ROW EXECUTE FUNCTION identity.set_updated_at();

-- Platform roles: the composite foreign key guarantees only platform-scoped roles are assigned here.
CREATE TABLE identity.platform_role_assignment (
  user_id     uuid        NOT NULL REFERENCES identity.user_account (id) ON DELETE CASCADE,
  role_key    text        NOT NULL,
  role_scope  text        NOT NULL DEFAULT 'platform' CHECK (role_scope = 'platform'),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  text        NOT NULL,
  PRIMARY KEY (user_id, role_key),
  FOREIGN KEY (role_key, role_scope) REFERENCES identity.role (key, scope) ON DELETE RESTRICT
);

-- Issuer memberships: a user's roles within one issuer; only tenant-scoped roles can be assigned.
CREATE TABLE identity.tenant_role_assignment (
  user_id     uuid        NOT NULL REFERENCES identity.user_account (id) ON DELETE CASCADE,
  tenant_id   uuid        NOT NULL,
  role_key    text        NOT NULL,
  role_scope  text        NOT NULL DEFAULT 'tenant' CHECK (role_scope = 'tenant'),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  text        NOT NULL,
  PRIMARY KEY (user_id, tenant_id, role_key),
  FOREIGN KEY (role_key, role_scope) REFERENCES identity.role (key, scope) ON DELETE RESTRICT
);
CREATE INDEX tenant_role_assignment_tenant_idx ON identity.tenant_role_assignment (tenant_id);
COMMENT ON COLUMN identity.tenant_role_assignment.tenant_id IS
  'Issuer tenant id (issuer-service). Referenced by value; validated through the issuer-service API.';

CREATE FUNCTION identity.rls_tenant_visible(tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('atlas.scope', true), '') = 'all'
        OR (coalesce(current_setting('atlas.scope', true), '') = 'tenant'
            AND tenant = ANY (coalesce(nullif(current_setting('atlas.tenant_ids', true), ''), '{}')::uuid[]));
  $$;

ALTER TABLE identity.tenant_role_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_role_assignment_isolation ON identity.tenant_role_assignment
  USING (identity.rls_tenant_visible(tenant_id))
  WITH CHECK (identity.rls_tenant_visible(tenant_id));

-- Position of the identity-provider event feed already ingested (failed sign-ins).
CREATE TABLE identity.idp_event_cursor (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_event_time  bigint  NOT NULL DEFAULT 0
);

CREATE TABLE identity.outbox (
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
CREATE INDEX outbox_pending_idx ON identity.outbox (next_attempt_at) WHERE published_at IS NULL;

-- Down Migration
DROP TABLE identity.outbox;
DROP TABLE identity.idp_event_cursor;
DROP POLICY tenant_role_assignment_isolation ON identity.tenant_role_assignment;
DROP FUNCTION identity.rls_tenant_visible(uuid);
DROP TABLE identity.tenant_role_assignment;
DROP TABLE identity.platform_role_assignment;
DROP TRIGGER role_set_updated_at ON identity.role;
DROP TRIGGER user_account_set_updated_at ON identity.user_account;
DROP FUNCTION identity.set_updated_at();
DROP TABLE identity.user_account;
DROP TABLE identity.role;
