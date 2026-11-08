-- SYNTHETIC DATA ONLY. These issuers do not exist. Safe to re-run.
INSERT INTO issuer.tenant (id, slug, display_name, status, is_synthetic) VALUES
  ('0b5c7e0a-1f00-4c3a-9a01-000000000001', 'synthetic-issuer-alpha', 'Synthetic Issuer Alpha', 'active', true),
  ('0b5c7e0a-1f00-4c3a-9a01-000000000002', 'synthetic-issuer-beta', 'Synthetic Issuer Beta', 'onboarding', true)
ON CONFLICT (id) DO NOTHING;
