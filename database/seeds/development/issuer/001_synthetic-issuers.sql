-- SYNTHETIC DATA ONLY. These issuers do not exist; names, references and settings are fictitious.
-- No real employer, customer or issuer data may ever be placed in seed files. Safe to re-run.
INSERT INTO issuer.tenant (id, slug, display_name, internal_reference, status, is_synthetic) VALUES
  ('1a2b0000-0000-4000-8000-000000000001', 'northstar-bank', 'Northstar Bank', 'NSB-0001', 'active', true),
  ('1a2b0000-0000-4000-8000-000000000002', 'meridian-financial', 'Meridian Financial', 'MRF-0001', 'active', true),
  ('1a2b0000-0000-4000-8000-000000000003', 'harbourline-credit-union', 'Harbourline Credit Union', 'HCU-0001', 'onboarding', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO issuer.tenant_configuration (tenant_id, version, settings, created_by) VALUES
  ('1a2b0000-0000-4000-8000-000000000001', 1,
   '{"timezone":"Europe/London","defaultLocale":"en-GB","supportContactEmail":"cardsupport@northstar.test","supportContactPhone":"+44 20 7946 0001","schemeParticipation":{"visa":true,"mastercard":true},"branding":{"primaryColour":"#3B82F6"}}',
   'seed'),
  ('1a2b0000-0000-4000-8000-000000000002', 1,
   '{"timezone":"Europe/Dublin","defaultLocale":"en-IE","supportContactEmail":"help@meridian.test","supportContactPhone":null,"schemeParticipation":{"visa":true,"mastercard":false},"branding":{"primaryColour":"#14B8A6"}}',
   'seed'),
  ('1a2b0000-0000-4000-8000-000000000003', 1,
   '{"timezone":"Europe/London","defaultLocale":"en-GB","supportContactEmail":null,"supportContactPhone":null,"schemeParticipation":{"visa":false,"mastercard":false},"branding":{"primaryColour":"#6D8DFF"}}',
   'seed')
ON CONFLICT (tenant_id, version) DO NOTHING;
