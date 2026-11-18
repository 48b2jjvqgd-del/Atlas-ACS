-- Owner: identity-service
-- Stage 1A security remediation: every user record is synthetic, enforced by the database.
--
-- Previously identity-service derived is_synthetic from ATLAS_ENV, so a deployment configured as
-- staging or production created non-synthetic users, and invitations accepted any email address.
-- The service now always writes true and accepts reserved synthetic domains only; these
-- constraints make both a database guarantee that no service credential, seed or direct write can
-- bypass. Introducing real users later is a deliberate, reviewed change (ADR-033), not a setting.
-- A failure applying this migration means real-looking data already exists: investigate it.
--
-- The email pattern is syntheticEmailDomainPattern in packages/contracts/src/synthetic.ts.

-- Up Migration
ALTER TABLE identity.user_account ALTER COLUMN is_synthetic SET DEFAULT true;
ALTER TABLE identity.user_account ADD CONSTRAINT user_account_stage_1a_synthetic_only CHECK (is_synthetic);
ALTER TABLE identity.user_account ADD CONSTRAINT user_account_stage_1a_synthetic_email CHECK (
  email ~ '@(([a-z0-9-]+\.)*(test|example|invalid|localhost)|([a-z0-9-]+\.)*example\.(com|net|org))$'
);
COMMENT ON COLUMN identity.user_account.is_synthetic IS
  'Always true in Stage 1A (constraint user_account_stage_1a_synthetic_only). See ADR-033.';

-- Down Migration
COMMENT ON COLUMN identity.user_account.is_synthetic IS NULL;
ALTER TABLE identity.user_account DROP CONSTRAINT user_account_stage_1a_synthetic_email;
ALTER TABLE identity.user_account DROP CONSTRAINT user_account_stage_1a_synthetic_only;
ALTER TABLE identity.user_account ALTER COLUMN is_synthetic SET DEFAULT false;
