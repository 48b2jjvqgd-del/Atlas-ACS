-- Owner: identity-service
-- Stage 1A security remediation: permission scopes and system roles enforced by the database.
--
-- Rules (packages/contracts/src/authz.ts is the single source of truth):
--   R1  every permission a role holds exists in the permission catalogue;
--   R2  a role may hold a permission only if the permission allows the role's scope, so a
--       platform-only permission (e.g. registering issuers, platform.users.manage) can never be
--       placed in a tenant role;
--   R3  a role's permission list has no duplicates and no nulls;
--   R4  system roles are written only by the migrator, which synchronises them from the catalogue;
--       the identity-service role can create and change custom roles only;
--   R5  platform roles are assigned only platform-wide and tenant roles only within a tenant
--       (already enforced by the composite foreign keys on the assignment tables).
--
-- Before this migration R1–R4 were checked by identity-service alone; a direct write with its
-- database credentials (or a bug in another code path) could have put platform-only permissions in
-- an issuer role.
--
-- The catalogue table is NOT maintained by hand in SQL: the migration tool fills it from
-- @atlas/contracts after every migration run (database/src/catalogue.ts), together with the system
-- roles, so there is exactly one catalogue. identity-service may only read it, and refuses
-- readiness if the database and the catalogue it was built with disagree.

-- Up Migration
CREATE TABLE identity.permission (
  key          text   PRIMARY KEY,
  scopes       text[] NOT NULL,
  description  text   NOT NULL DEFAULT '',
  category     text   NOT NULL DEFAULT '',
  CONSTRAINT permission_key_format CHECK (key ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
  CONSTRAINT permission_scopes_valid CHECK (
    cardinality(scopes) BETWEEN 1 AND 2
    AND scopes <@ ARRAY['platform', 'tenant']::text[]
    AND array_position(scopes, NULL) IS NULL
  )
);
COMMENT ON TABLE identity.permission IS
  'Permission catalogue, synchronised from @atlas/contracts by the migration tool. Read-only for identity-service.';

-- Permissions in p_permissions that a role of scope p_scope may not hold (R1, R2).
CREATE FUNCTION identity.role_permission_violations(p_scope text, p_permissions text[]) RETURNS text[]
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(array_agg(p ORDER BY p), '{}')
      FROM unnest(p_permissions) AS p
     WHERE NOT EXISTS (
       SELECT 1 FROM identity.permission c WHERE c.key = p AND p_scope = ANY (c.scopes)
     );
  $$;

CREATE FUNCTION identity.enforce_role_permission_scope() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  invalid text[];
BEGIN
  IF array_position(NEW.permissions, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'role % lists a null permission', NEW.key
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permission_scope';
  END IF;
  IF cardinality(NEW.permissions) <> (SELECT count(DISTINCT p) FROM unnest(NEW.permissions) AS p) THEN
    RAISE EXCEPTION 'role % lists a permission more than once', NEW.key
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permission_scope';
  END IF;
  invalid := identity.role_permission_violations(NEW.scope, NEW.permissions);
  IF cardinality(invalid) > 0 THEN
    RAISE EXCEPTION 'a % role cannot hold: %', NEW.scope, array_to_string(invalid, ', ')
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permission_scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_permission_scope
  BEFORE INSERT OR UPDATE OF scope, permissions ON identity.role
  FOR EACH ROW EXECUTE FUNCTION identity.enforce_role_permission_scope();

-- Narrowing or removing a catalogue entry must not leave any role holding it (checked at commit,
-- so the synchronisation can update the catalogue and the system roles in one transaction).
CREATE FUNCTION identity.enforce_permission_catalogue_consistency() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(r.key || ' (' || array_to_string(identity.role_permission_violations(r.scope, r.permissions), ', ') || ')', '; ' ORDER BY r.key)
    INTO offending
    FROM identity.role r
   WHERE cardinality(identity.role_permission_violations(r.scope, r.permissions)) > 0;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'permission catalogue change leaves roles holding permissions outside their scope: %', offending
      USING ERRCODE = 'check_violation', CONSTRAINT = 'role_permission_scope';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER permission_catalogue_consistency
  AFTER UPDATE OR DELETE ON identity.permission
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity.enforce_permission_catalogue_consistency();

-- R4: system roles are invisible to writes by any role subject to row-level security (every
-- service role). The table owner — the migrator — is exempt and synchronises them.
ALTER TABLE identity.role ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_read ON identity.role FOR SELECT USING (true);
CREATE POLICY role_custom_insert ON identity.role FOR INSERT WITH CHECK (NOT is_system);
CREATE POLICY role_custom_update ON identity.role FOR UPDATE
  USING (NOT is_system) WITH CHECK (NOT is_system);
CREATE POLICY role_custom_delete ON identity.role FOR DELETE USING (NOT is_system);

COMMENT ON TABLE identity.role IS
  'Roles. System roles are synchronised from the contracts catalogue by the migration tool and are read-only for identity-service (row-level security).';

-- Down Migration
COMMENT ON TABLE identity.role IS
  'Roles. System roles are synchronised from the contracts catalogue at service start and are read-only.';
DROP POLICY role_custom_delete ON identity.role;
DROP POLICY role_custom_update ON identity.role;
DROP POLICY role_custom_insert ON identity.role;
DROP POLICY role_read ON identity.role;
ALTER TABLE identity.role DISABLE ROW LEVEL SECURITY;
DROP TRIGGER permission_catalogue_consistency ON identity.permission;
DROP FUNCTION identity.enforce_permission_catalogue_consistency();
DROP TRIGGER role_permission_scope ON identity.role;
DROP FUNCTION identity.enforce_role_permission_scope();
DROP FUNCTION identity.role_permission_violations(text, text[]);
DROP TABLE identity.permission;
