-- Owner: issuer-service
-- Creates the tenant (issuer) registry: the platform's tenancy foundation. Every tenant-scoped
-- record in any service references a tenant id from here (by value — never by cross-schema FK).

-- Up Migration
CREATE TABLE issuer.tenant (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        NOT NULL,
  display_name  text        NOT NULL,
  status        text        NOT NULL DEFAULT 'onboarding',
  is_synthetic  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_slug_key UNIQUE (slug),
  CONSTRAINT tenant_slug_format CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' AND length(slug) BETWEEN 2 AND 63),
  CONSTRAINT tenant_display_name_length CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT tenant_status_valid CHECK (status IN ('onboarding', 'active', 'suspended', 'offboarded'))
);

COMMENT ON TABLE issuer.tenant IS 'Issuer tenants. System of record: issuer-service.';
COMMENT ON COLUMN issuer.tenant.is_synthetic IS 'True for synthetic development/simulation data.';

CREATE FUNCTION issuer.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_set_updated_at
  BEFORE UPDATE ON issuer.tenant
  FOR EACH ROW EXECUTE FUNCTION issuer.set_updated_at();

-- Down Migration
DROP TRIGGER tenant_set_updated_at ON issuer.tenant;
DROP FUNCTION issuer.set_updated_at();
DROP TABLE issuer.tenant;
