-- 001: preconditions, extensions and helper functions.
-- Roles (qenbel_migrate, qenbel_app, qenbel_platform) are created by infra/postgres/init at cluster
-- creation (superuser work). This migration only verifies them so a missing role fails loudly.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['qenbel_migrate', 'qenbel_app', 'qenbel_platform']) AS name LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      RAISE EXCEPTION 'Role % does not exist. Create it first (see infra/postgres/init/01-roles-and-databases.sh).', r.name;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qenbel_app' AND (rolbypassrls OR rolsuper)) THEN
    RAISE EXCEPTION 'qenbel_app must be NOSUPERUSER NOBYPASSRLS (it is the runtime role and must be subject to RLS).';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- The tenant for this transaction. Set with set_config('app.tenant_id', <uuid>, true).
-- Unset or empty => NULL => every policy comparison is NULL => zero rows (never an error).
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- SQL-side equivalent of withTenant() for scripts and psql sessions. Transaction-local.
CREATE FUNCTION app_set_tenant(p_tenant_id uuid) RETURNS void
  LANGUAGE plpgsql
  AS $$ BEGIN PERFORM set_config('app.tenant_id', p_tenant_id::text, true); END $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

COMMENT ON FUNCTION current_tenant_id() IS 'Tenant for this transaction from app.tenant_id; NULL when unset.';
