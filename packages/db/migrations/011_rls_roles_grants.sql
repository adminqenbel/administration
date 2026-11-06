-- 011: Row-Level Security, grants, and the small set of SECURITY DEFINER functions.
--
-- Model (docs/ARCHITECTURE.md section 3):
--   qenbel_migrate   owns every object. FORCE RLS applies to it too, so even the owner sees nothing without a tenant.
--   qenbel_app       runtime. NOBYPASSRLS. Only the DML grants below. Never owns anything.
--   qenbel_platform  NOLOGIN, BYPASSRLS. Owns only the SECURITY DEFINER functions at the bottom of this file.
--                    Nothing connects as it; it exists so a handful of narrow functions can do the work that
--                    by nature has no tenant yet (credential lookup, tenant creation, cross-tenant sweeps).

GRANT USAGE ON SCHEMA public TO qenbel_app, qenbel_platform;
GRANT CREATE ON SCHEMA public TO qenbel_platform;   -- needed only so function ownership can be transferred

-- Turns on tenant isolation for one table. Every later migration that adds a tenant table must call this
-- (the test suite fails if a table with a tenant_id column has no forced RLS policy).
CREATE FUNCTION app_secure_tenant_table(p_table regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  -- Missing app.tenant_id => current_tenant_id() is NULL => comparison is NULL => no rows, no error.
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())',
    p_table);
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_table AND attname = 'updated_at' AND NOT attisdropped) THEN
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', p_table);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', p_table);
  END IF;
END $$;

REVOKE ALL ON FUNCTION app_secure_tenant_table(regclass) FROM PUBLIC;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    PERFORM app_secure_tenant_table(quote_ident(t.table_name)::regclass);
  END LOOP;
END $$;

-- tenants has no tenant_id; its row is visible and editable only to its own tenant.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

-- ---------------------------------------------------------------------------------------------
-- Grants for the runtime role. Start from nothing, add what is needed.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, qenbel_app;

-- Platform tables: read-only reference data; the tenant may edit a few columns of its own row.
GRANT SELECT ON tool_definitions, config_pack_versions TO qenbel_app;
GRANT SELECT ON tenants TO qenbel_app;
GRANT UPDATE (name, pack_id, pack_version, default_timezone, settings) ON tenants TO qenbel_app;
-- platform_admins: no grant. Checked only through auth_is_platform_admin().

-- Tenant tables: select, insert, update.
GRANT SELECT, INSERT, UPDATE ON
  locations, users, user_locations, api_credentials, tenant_tool_settings,
  customers, customer_tags, customer_notes,
  catalogue_categories, catalogue_items, catalogue_variants,
  resources, resource_schedules, business_hours, holidays,
  conversations,
  bookings, booking_allocations,
  orders, order_items, fulfilments,
  follow_up_tasks, communications, notification_templates, notifications,
  idempotency_keys, outbox_events, webhook_endpoints, webhook_deliveries
  TO qenbel_app;

-- Delete only where removing rows is a normal operation (join rows, drafts, housekeeping). Records that carry
-- history (customers, catalogue items, resources, users, locations, bookings, orders, payments, conversations)
-- are archived or status-changed, never deleted.
GRANT DELETE ON
  user_locations, tenant_tool_settings, customer_tags,
  catalogue_categories, catalogue_variants, resource_schedules, business_hours, holidays,
  order_items, fulfilments, follow_up_tasks, notification_templates,
  idempotency_keys, outbox_events, webhook_endpoints, webhook_deliveries
  TO qenbel_app;

-- Transcript: add messages, read them, never rewrite them.
GRANT SELECT, INSERT ON conversation_messages TO qenbel_app;

-- Ledger: insert and read; a pending entry may settle (status, provider_reference). No delete.
GRANT SELECT, INSERT ON payments TO qenbel_app;
GRANT UPDATE (status, provider_reference, updated_at) ON payments TO qenbel_app;

-- Audit: insert and read only.
GRANT SELECT, INSERT ON audit_log TO qenbel_app;

-- ---------------------------------------------------------------------------------------------
-- Narrow SECURITY DEFINER functions, owned by qenbel_platform (BYPASSRLS).
-- Each pins search_path and takes only the arguments it needs. They are the only way around RLS.
-- ---------------------------------------------------------------------------------------------

-- Tenant lifecycle. Authorisation (PLATFORM_ADMIN) is enforced by the API before it calls these.
CREATE FUNCTION platform_create_tenant(
  p_slug text, p_name text,
  p_deployment_mode text DEFAULT 'central',
  p_pack_id text DEFAULT NULL, p_pack_version text DEFAULT NULL,
  p_timezone text DEFAULT 'Asia/Kolkata',
  p_id uuid DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO tenants (id, slug, name, deployment_mode, pack_id, pack_version, default_timezone)
  VALUES (coalesce(p_id, gen_random_uuid()), p_slug, p_name, p_deployment_mode, p_pack_id, p_pack_version, p_timezone)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION platform_set_tenant_status(p_tenant_id uuid, p_status text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  UPDATE tenants SET status = p_status WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant not found' USING ERRCODE = 'P0002';
  END IF;
END $$;

-- Ids of active tenants, for workers that must visit every tenant (each visit then runs under withTenant()).
CREATE FUNCTION platform_list_active_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at $$;

-- Principal resolution happens before any tenant context exists, so these three look across tenants.
-- They return only what authentication needs; the API still verifies tokens and hashes itself.
CREATE FUNCTION auth_lookup_user(p_provider text, p_subject text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.role, u.name
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.auth_provider = p_provider AND u.external_subject = p_subject
       AND u.disabled_at IS NULL AND t.status = 'active'
  $$;

CREATE FUNCTION auth_lookup_credential(p_lookup_id text)
  RETURNS TABLE (credential_id uuid, tenant_id uuid, credential_type text, secret_hash text, pepper_version smallint,
                 tool_scopes text[], allowed_origins text[], expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.tenant_id, c.credential_type, c.secret_hash, c.pepper_version,
           c.tool_scopes, c.allowed_origins, c.expires_at, c.revoked_at
      FROM api_credentials c JOIN tenants t ON t.id = c.tenant_id
     WHERE c.lookup_id = p_lookup_id AND t.status = 'active'
  $$;

CREATE FUNCTION auth_is_platform_admin(p_provider text, p_subject text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM platform_admins
                    WHERE auth_provider = p_provider AND external_subject = p_subject AND disabled_at IS NULL)
  $$;

-- Housekeeping across tenants.
CREATE FUNCTION purge_expired_idempotency_keys() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  WITH d AS (DELETE FROM idempotency_keys WHERE expires_at < now() RETURNING 1) SELECT count(*) INTO n FROM d;
  RETURN n;
END $$;

-- Table privileges the definer functions need (and nothing else).
GRANT SELECT, INSERT, UPDATE ON tenants TO qenbel_platform;
GRANT SELECT ON platform_admins, users, api_credentials TO qenbel_platform;
GRANT SELECT, UPDATE ON bookings, booking_allocations TO qenbel_platform;
GRANT SELECT, DELETE ON idempotency_keys TO qenbel_platform;

ALTER FUNCTION platform_create_tenant(text, text, text, text, text, text, uuid) OWNER TO qenbel_platform;
ALTER FUNCTION platform_set_tenant_status(uuid, text) OWNER TO qenbel_platform;
ALTER FUNCTION platform_list_active_tenants() OWNER TO qenbel_platform;
ALTER FUNCTION auth_lookup_user(text, text) OWNER TO qenbel_platform;
ALTER FUNCTION auth_lookup_credential(text) OWNER TO qenbel_platform;
ALTER FUNCTION auth_is_platform_admin(text, text) OWNER TO qenbel_platform;
ALTER FUNCTION purge_expired_idempotency_keys() OWNER TO qenbel_platform;
ALTER FUNCTION expire_booking_holds(timestamptz) OWNER TO qenbel_platform;

REVOKE ALL ON FUNCTION
  platform_create_tenant(text, text, text, text, text, text, uuid),
  platform_set_tenant_status(uuid, text),
  platform_list_active_tenants(),
  auth_lookup_user(text, text),
  auth_lookup_credential(text),
  auth_is_platform_admin(text, text),
  purge_expired_idempotency_keys(),
  expire_booking_holds(timestamptz),
  expire_booking_holds_for_current_tenant(timestamptz),
  app_set_tenant(uuid)
  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  platform_create_tenant(text, text, text, text, text, text, uuid),
  platform_set_tenant_status(uuid, text),
  platform_list_active_tenants(),
  auth_lookup_user(text, text),
  auth_lookup_credential(text),
  auth_is_platform_admin(text, text),
  purge_expired_idempotency_keys(),
  expire_booking_holds(timestamptz),
  expire_booking_holds_for_current_tenant(timestamptz),
  app_set_tenant(uuid)
  TO qenbel_app;
