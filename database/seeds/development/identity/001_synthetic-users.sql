-- SYNTHETIC DATA ONLY. These people do not exist. Addresses use the reserved .test domain.
-- idp_subject values match the user ids in infrastructure/docker/keycloak/atlas-realm.json, so
-- signing in to the local Keycloak maps each account onto these records. Safe to re-run.
INSERT INTO identity.user_account (id, idp_subject, email, display_name, status, is_synthetic) VALUES
  ('7c000000-0000-4000-8000-000000000001', '5ab00000-0000-4000-8000-000000000001', 'super.admin@atlas.test',        'Avery Quinn',    'active', true),
  ('7c000000-0000-4000-8000-000000000002', '5ab00000-0000-4000-8000-000000000002', 'platform.admin@atlas.test',     'Jordan Ellis',   'active', true),
  ('7c000000-0000-4000-8000-000000000003', '5ab00000-0000-4000-8000-000000000003', 'tech.admin@atlas.test',         'Sam Okafor',     'active', true),
  ('7c000000-0000-4000-8000-000000000011', '5ab00000-0000-4000-8000-000000000011', 'admin@northstar.test',          'Priya Raman',    'active', true),
  ('7c000000-0000-4000-8000-000000000012', '5ab00000-0000-4000-8000-000000000012', 'fraud.manager@northstar.test',  'Daniel Brooks',  'active', true),
  ('7c000000-0000-4000-8000-000000000013', '5ab00000-0000-4000-8000-000000000013', 'fraud.analyst@northstar.test',  'Mei Lin',        'active', true),
  ('7c000000-0000-4000-8000-000000000014', '5ab00000-0000-4000-8000-000000000014', 'compliance@northstar.test',     'Oliver Grant',   'active', true),
  ('7c000000-0000-4000-8000-000000000015', '5ab00000-0000-4000-8000-000000000015', 'operations@northstar.test',     'Hannah Wright',  'active', true),
  ('7c000000-0000-4000-8000-000000000016', '5ab00000-0000-4000-8000-000000000016', 'support@northstar.test',        'Leo Martins',    'active', true),
  ('7c000000-0000-4000-8000-000000000017', '5ab00000-0000-4000-8000-000000000017', 'reporting@northstar.test',      'Grace Kim',      'active', true),
  ('7c000000-0000-4000-8000-000000000021', '5ab00000-0000-4000-8000-000000000021', 'admin@meridian.test',           'Tomasz Nowak',   'active', true),
  ('7c000000-0000-4000-8000-000000000022', '5ab00000-0000-4000-8000-000000000022', 'support@meridian.test',         'Aisha Bello',    'active', true),
  ('7c000000-0000-4000-8000-000000000023', '5ab00000-0000-4000-8000-000000000023', 'reporting@meridian.test',       'Ruth Adeyemi',   'active', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO identity.platform_role_assignment (user_id, role_key, granted_by) VALUES
  ('7c000000-0000-4000-8000-000000000001', 'platform-super-admin',    'seed'),
  ('7c000000-0000-4000-8000-000000000002', 'platform-administrator',  'seed'),
  ('7c000000-0000-4000-8000-000000000003', 'technical-administrator', 'seed')
ON CONFLICT DO NOTHING;

-- Northstar Bank = 1a2b…0001, Meridian Financial = 1a2b…0002 (issuer seed).
INSERT INTO identity.tenant_role_assignment (user_id, tenant_id, role_key, granted_by) VALUES
  ('7c000000-0000-4000-8000-000000000011', '1a2b0000-0000-4000-8000-000000000001', 'issuer-administrator', 'seed'),
  ('7c000000-0000-4000-8000-000000000012', '1a2b0000-0000-4000-8000-000000000001', 'fraud-manager',        'seed'),
  ('7c000000-0000-4000-8000-000000000013', '1a2b0000-0000-4000-8000-000000000001', 'fraud-analyst',        'seed'),
  ('7c000000-0000-4000-8000-000000000014', '1a2b0000-0000-4000-8000-000000000001', 'compliance-officer',   'seed'),
  ('7c000000-0000-4000-8000-000000000015', '1a2b0000-0000-4000-8000-000000000001', 'operations-manager',   'seed'),
  ('7c000000-0000-4000-8000-000000000016', '1a2b0000-0000-4000-8000-000000000001', 'customer-support',     'seed'),
  ('7c000000-0000-4000-8000-000000000017', '1a2b0000-0000-4000-8000-000000000001', 'reporting-user',       'seed'),
  ('7c000000-0000-4000-8000-000000000021', '1a2b0000-0000-4000-8000-000000000002', 'issuer-administrator', 'seed'),
  ('7c000000-0000-4000-8000-000000000022', '1a2b0000-0000-4000-8000-000000000002', 'customer-support',     'seed'),
  ('7c000000-0000-4000-8000-000000000023', '1a2b0000-0000-4000-8000-000000000002', 'reporting-user',       'seed')
ON CONFLICT DO NOTHING;
