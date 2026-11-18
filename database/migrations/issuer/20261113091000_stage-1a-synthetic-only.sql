-- Owner: issuer-service
-- Stage 1A security remediation: every issuer record is synthetic, enforced by the database.
--
-- Stage 1A must not hold real issuer data. Previously issuer-service derived is_synthetic from
-- ATLAS_ENV, so a deployment configured as staging or production created non-synthetic issuers.
-- The service now always writes true, and these constraints make that a database guarantee:
-- no service credential, seed or direct write can store a non-synthetic issuer, or an issuer
-- support contact on a routable email domain.
--
-- Introducing real issuers later is a deliberate, reviewed change (ADR-033): a new migration that
-- drops these constraints together with the production controls that must accompany real data.
-- It is intentionally not something configuration can switch on. A failure applying this
-- migration means non-synthetic rows already exist and must be investigated, not overridden.
--
-- The email pattern is syntheticEmailDomainPattern in packages/contracts/src/synthetic.ts.

-- Up Migration
ALTER TABLE issuer.tenant ALTER COLUMN is_synthetic SET DEFAULT true;
ALTER TABLE issuer.tenant ADD CONSTRAINT tenant_stage_1a_synthetic_only CHECK (is_synthetic);
COMMENT ON COLUMN issuer.tenant.is_synthetic IS
  'Always true in Stage 1A (constraint tenant_stage_1a_synthetic_only). See ADR-033.';

ALTER TABLE issuer.tenant_configuration ADD CONSTRAINT tenant_configuration_stage_1a_synthetic_contact CHECK (
  settings->>'supportContactEmail' IS NULL
  OR lower(settings->>'supportContactEmail') ~ '@(([a-z0-9-]+\.)*(test|example|invalid|localhost)|([a-z0-9-]+\.)*example\.(com|net|org))$'
);

-- Down Migration
ALTER TABLE issuer.tenant_configuration DROP CONSTRAINT tenant_configuration_stage_1a_synthetic_contact;
COMMENT ON COLUMN issuer.tenant.is_synthetic IS 'True for synthetic development/simulation data.';
ALTER TABLE issuer.tenant DROP CONSTRAINT tenant_stage_1a_synthetic_only;
ALTER TABLE issuer.tenant ALTER COLUMN is_synthetic SET DEFAULT false;
