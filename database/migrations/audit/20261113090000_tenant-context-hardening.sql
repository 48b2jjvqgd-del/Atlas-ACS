-- Owner: audit-service
-- Stage 1A security remediation: a database-held, set-once tenant context for row-level security.
--
-- Before this migration the RLS policies read the custom settings atlas.scope / atlas.tenant_ids.
-- Any role can change a custom setting with set_config(), so a single injected SQL expression in a
-- tenant-scoped transaction (e.g. "... OR set_config('atlas.scope', 'all', true) IS NULL") could
-- widen that transaction to every tenant. The settings were therefore only a guard against
-- *accidental* unscoped queries.
--
-- Now the context lives in a table the service role cannot read or write. It is set through one
-- SECURITY DEFINER function, at most once per transaction, keyed on the backend and the
-- transaction id (xid8, never reused), so:
--   * set_config() / SET have no effect on visibility any more;
--   * a statement running inside a tenant-scoped transaction cannot widen or replace the scope;
--   * a context can never be seen by a later transaction on the same pooled connection, because
--     that transaction has a different xid.
--
-- What this does NOT do: a caller that controls the whole connection (a compromised service
-- process with its credentials) can open a fresh transaction and declare platform-wide scope,
-- exactly as the service legitimately does for platform administrators. See SECURITY_MODEL.md,
-- "Tenant isolation", for the precise guarantee and the production options.

-- Up Migration
CREATE UNLOGGED TABLE audit.tenant_context (
  backend_pid  integer PRIMARY KEY,
  xact_id      xid8    NOT NULL,
  scope        text    NOT NULL,
  tenant_ids   uuid[]  NOT NULL,
  CONSTRAINT tenant_context_scope_valid CHECK (scope IN ('all', 'tenant')),
  CONSTRAINT tenant_context_all_has_no_list CHECK (scope = 'tenant' OR cardinality(tenant_ids) = 0)
);
COMMENT ON TABLE audit.tenant_context IS
  'Row-level-security context per backend and transaction. Written only by begin_tenant_context(); no service role may read or write it.';

-- Default privileges may already have granted the service role DML on the new table; revoke every
-- grant except the owner's without naming roles (migrations never mention roles).
DO $$
DECLARE grantee text;
BEGIN
  REVOKE ALL ON audit.tenant_context FROM PUBLIC;
  FOR grantee IN
    SELECT DISTINCT a.grantee::regrole::text
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.oid = 'audit.tenant_context'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0
  LOOP
    EXECUTE format('REVOKE ALL ON audit.tenant_context FROM %s', grantee);
  END LOOP;
END $$;

CREATE FUNCTION audit.begin_tenant_context(p_scope text, p_tenant_ids uuid[]) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_xact xid8 := pg_current_xact_id();
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'tenant') THEN
    RAISE EXCEPTION 'tenant context scope must be all or tenant' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope = 'all' AND coalesce(cardinality(p_tenant_ids), 0) > 0 THEN
    RAISE EXCEPTION 'platform-wide tenant context takes no tenant list' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_scope = 'tenant' AND (p_tenant_ids IS NULL OR array_position(p_tenant_ids, NULL) IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant context needs a tenant list without nulls' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM audit.tenant_context
              WHERE backend_pid = pg_backend_pid() AND xact_id = v_xact) THEN
    RAISE EXCEPTION 'tenant context is already set for this transaction and cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO audit.tenant_context (backend_pid, xact_id, scope, tenant_ids)
  VALUES (pg_backend_pid(), v_xact, p_scope, coalesce(p_tenant_ids, '{}'))
  ON CONFLICT (backend_pid) DO UPDATE
    SET xact_id = EXCLUDED.xact_id, scope = EXCLUDED.scope, tenant_ids = EXCLUDED.tenant_ids;
END;
$$;
COMMENT ON FUNCTION audit.begin_tenant_context(text, uuid[]) IS
  'Sets the RLS tenant context for the current transaction. Callable once per transaction.';

CREATE FUNCTION audit.tenant_context_all() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce((SELECT c.scope = 'all' FROM audit.tenant_context c
                      WHERE c.backend_pid = pg_backend_pid()
                        AND c.xact_id = pg_current_xact_id_if_assigned()), false);
  $$;

CREATE FUNCTION audit.tenant_context_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce((SELECT c.tenant_ids FROM audit.tenant_context c
                      WHERE c.backend_pid = pg_backend_pid()
                        AND c.xact_id = pg_current_xact_id_if_assigned()
                        AND c.scope = 'tenant'), '{}'::uuid[]);
  $$;

REVOKE ALL ON FUNCTION audit.begin_tenant_context(text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.tenant_context_all() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit.tenant_context_ids() FROM PUBLIC;

-- Policies read the context through scalar sub-selects, evaluated once per statement (InitPlan).
-- Platform rows (tenant_id IS NULL) are visible only with platform-wide scope: NULL = ANY(...) is
-- never true.
DROP POLICY audit_record_isolation ON audit.audit_record;
CREATE POLICY audit_record_isolation ON audit.audit_record
  FOR SELECT USING ((SELECT audit.tenant_context_all()) OR tenant_id = ANY ((SELECT audit.tenant_context_ids())::uuid[]));
-- The consumer records events for every tenant; it writes with platform-wide scope.
DROP POLICY audit_record_append ON audit.audit_record;
CREATE POLICY audit_record_append ON audit.audit_record
  FOR INSERT WITH CHECK ((SELECT audit.tenant_context_all()));

-- The setting-based predicate is gone, so nothing can be widened through set_config().
DROP FUNCTION audit.rls_tenant_visible(uuid);

-- Down Migration
CREATE FUNCTION audit.rls_tenant_visible(tenant uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('atlas.scope', true), '') = 'all'
        OR (coalesce(current_setting('atlas.scope', true), '') = 'tenant'
            AND tenant IS NOT NULL
            AND tenant = ANY (coalesce(nullif(current_setting('atlas.tenant_ids', true), ''), '{}')::uuid[]));
  $$;
DROP POLICY audit_record_append ON audit.audit_record;
CREATE POLICY audit_record_append ON audit.audit_record
  FOR INSERT WITH CHECK (coalesce(current_setting('atlas.scope', true), '') = 'all');
DROP POLICY audit_record_isolation ON audit.audit_record;
CREATE POLICY audit_record_isolation ON audit.audit_record
  FOR SELECT USING (audit.rls_tenant_visible(tenant_id));
DROP FUNCTION audit.tenant_context_ids();
DROP FUNCTION audit.tenant_context_all();
DROP FUNCTION audit.begin_tenant_context(text, uuid[]);
DROP TABLE audit.tenant_context;
