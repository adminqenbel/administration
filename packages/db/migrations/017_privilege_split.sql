-- 017: split database privileges by purpose (docs/security/REVIEW-stage2.md SEC-001, SEC-002, SEC-003 part 1).
--
-- Problems in 011:
--   * the REVOKE/GRANT on the SECURITY DEFINER functions ran AFTER ownership moved to qenbel_platform, as a role without
--     grant option, so PostgreSQL only warned and nothing changed: every function stayed executable by PUBLIC (SEC-001);
--   * the runtime role (qenbel_app) could therefore call platform functions: suspend or create tenants, sweep every
--     tenant's holds with a caller-chosen clock, read another tenant's API key hash (SEC-002);
--   * app_set_tenant(uuid) let any statement of the runtime role retarget RLS (SEC-003).
--
-- After this migration (verified by test/privileges.test.ts, which fails if it drifts):
--   PUBLIC            may execute only current_tenant_id() (needed by the policies, reads one setting).
--   qenbel_app        may execute only current_tenant_id() and expire_booking_holds_for_current_tenant(timestamptz)
--                     (the second one is SECURITY INVOKER: it runs under the caller's RLS, so it can only touch the caller's tenant).
--   qenbel_auth       auth_lookup_user, auth_lookup_credential, auth_is_platform_admin. No table privilege.
--   qenbel_platform_ops   platform_create_tenant, platform_create_tenant_with_owner, platform_set_tenant_status,
--                     platform_list_active_tenants, expire_booking_holds, purge_expired_idempotency_keys. No table privilege.
-- The two LOGIN roles are created by infra/postgres/apply-roles.sh (superuser work), never by a migration.
-- New functions: ALTER DEFAULT PRIVILEGES below makes them non-PUBLIC from the start.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['qenbel_auth', 'qenbel_platform_ops'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      RAISE EXCEPTION 'Role % does not exist. Run infra/postgres/apply-roles.sh (superuser) once, then migrate again.', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
      RAISE EXCEPTION 'Role % must be NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB.', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles x ON x.oid = m.member WHERE x.rolname = r) THEN
      RAISE EXCEPTION 'Role % must not be a member of any other role.', r;
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO qenbel_auth, qenbel_platform_ops;

-- ---------------------------------------------------------------------------------------------
-- 1. Functions owned by qenbel_migrate (this role): nothing is PUBLIC-executable except current_tenant_id().
--    ALTER DEFAULT PRIVILEGES must NOT use IN SCHEMA: a schema-level entry can only add to the global default
--    (PUBLIC EXECUTE), never remove it.
-- ---------------------------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE qenbel_migrate REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND pg_get_userbyid(p.proowner) = 'qenbel_migrate'
       AND p.proname <> 'current_tenant_id'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')   -- not an extension member
  LOOP
    -- Trigger functions are checked for EXECUTE only when the trigger is created, never when it fires.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, qenbel_app, qenbel_auth, qenbel_platform_ops', f.sig);
  END LOOP;
END $$;

-- The one tenant-level function the runtime role may call. SECURITY INVOKER: under the caller's own RLS.
GRANT EXECUTE ON FUNCTION expire_booking_holds_for_current_tenant(timestamptz) TO qenbel_app;

-- ---------------------------------------------------------------------------------------------
-- 2. Privileges the definer role needs for the one new function (tenant + first owner + audit row in one transaction).
-- ---------------------------------------------------------------------------------------------
GRANT INSERT ON users, audit_log TO qenbel_platform;

-- ---------------------------------------------------------------------------------------------
-- 3. Definer functions. They are owned by qenbel_platform, so their ACLs can only be changed as that role
--    (011 did it as qenbel_migrate, which is why it was a no-op). The migration role may SET ROLE to it (see infra init).
-- ---------------------------------------------------------------------------------------------
SET LOCAL ROLE qenbel_platform;

ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 3a. The cross-tenant hold sweep no longer takes a clock. A caller-chosen "now" in the future expired every live
--     hold of every tenant; the sweep now always uses the database clock.
DROP FUNCTION expire_booking_holds(timestamptz);

CREATE FUNCTION expire_booking_holds() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  n integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  -- Lock order resource -> booking -> allocation (migration 016).
  PERFORM 1 FROM resources r
   WHERE r.id IN (
     SELECT a.resource_id FROM booking_allocations a
      WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= v_now
     UNION
     SELECT a.resource_id FROM booking_allocations a JOIN bookings b ON b.tenant_id = a.tenant_id AND b.id = a.booking_id
      WHERE a.active AND b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= v_now)
   ORDER BY r.id
   FOR NO KEY UPDATE;

  PERFORM 1 FROM bookings b
   WHERE (b.status = 'HOLD' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= v_now)
      OR b.id IN (SELECT a.booking_id FROM booking_allocations a WHERE a.active AND a.expires_at IS NOT NULL AND a.expires_at <= v_now)
   ORDER BY b.id
   FOR NO KEY UPDATE;

  WITH expired AS (
    UPDATE bookings
       SET status = 'EXPIRED', version = version + 1, updated_at = now()
     WHERE status = 'HOLD' AND hold_expires_at IS NOT NULL AND hold_expires_at <= v_now
    RETURNING id
  )
  SELECT count(*) INTO n FROM expired;

  UPDATE booking_allocations SET active = false, updated_at = now()
   WHERE active AND expires_at IS NOT NULL AND expires_at <= v_now;

  RETURN n;
END $$;

-- 3b. Tenant + first OWNER + audit row atomically. platform_create_tenant() alone cannot be combined with the
--     owner insert in one transaction any more, because the runtime role can no longer call it.
--     Authorisation (PLATFORM_ADMIN) is still enforced by the API before it calls this; the database cannot check it.
CREATE FUNCTION platform_create_tenant_with_owner(
  p_slug text, p_name text,
  p_deployment_mode text,
  p_pack_id text, p_pack_version text,
  p_timezone text,
  p_id uuid,
  p_owner_provider text, p_owner_subject text, p_owner_email text, p_owner_name text,
  p_actor_id text DEFAULT NULL, p_request_id text DEFAULT NULL, p_ip text DEFAULT NULL,
  p_audit_details jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (tenant_id uuid, owner_user_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_tenant uuid;
  v_owner  uuid;
BEGIN
  INSERT INTO tenants (id, slug, name, deployment_mode, pack_id, pack_version, default_timezone)
  VALUES (coalesce(p_id, gen_random_uuid()), p_slug, p_name, p_deployment_mode, p_pack_id, p_pack_version, p_timezone)
  RETURNING id INTO v_tenant;

  INSERT INTO users (tenant_id, auth_provider, external_subject, email, name, role)
  VALUES (v_tenant, p_owner_provider, p_owner_subject, p_owner_email, p_owner_name, 'OWNER')
  RETURNING id INTO v_owner;

  INSERT INTO audit_log (tenant_id, actor_kind, actor_id, action, entity_type, entity_id, outcome, channel, request_id, ip_address, details)
  VALUES (v_tenant, 'platform_admin', p_actor_id, 'platform.tenant.create', 'tenant', v_tenant::text, 'success',
          'dashboard', p_request_id, p_ip, coalesce(p_audit_details, '{}'::jsonb));

  RETURN QUERY SELECT v_tenant, v_owner;
END $$;

-- 3c. ACLs, stated in full. ALL covers EXECUTE; the grantor is the owner, so this time it takes effect.
REVOKE ALL ON FUNCTION
  platform_create_tenant(text, text, text, text, text, text, uuid),
  platform_create_tenant_with_owner(text, text, text, text, text, text, uuid, text, text, text, text, text, text, text, jsonb),
  platform_set_tenant_status(uuid, text),
  platform_list_active_tenants(),
  auth_lookup_user(text, text),
  auth_lookup_credential(text),
  auth_is_platform_admin(text, text),
  purge_expired_idempotency_keys(),
  expire_booking_holds()
  FROM PUBLIC, qenbel_app, qenbel_auth, qenbel_platform_ops;

GRANT EXECUTE ON FUNCTION
  auth_lookup_user(text, text),
  auth_lookup_credential(text),
  auth_is_platform_admin(text, text)
  TO qenbel_auth;

GRANT EXECUTE ON FUNCTION
  platform_create_tenant(text, text, text, text, text, text, uuid),
  platform_create_tenant_with_owner(text, text, text, text, text, text, uuid, text, text, text, text, text, text, text, jsonb),
  platform_set_tenant_status(uuid, text),
  platform_list_active_tenants(),
  purge_expired_idempotency_keys(),
  expire_booking_holds()
  TO qenbel_platform_ops;

RESET ROLE;
