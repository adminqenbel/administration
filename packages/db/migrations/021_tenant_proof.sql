-- 021: optional signed tenant context (docs/security/REVIEW-stage2.md SEC-003, part 2).
--
-- The problem: the tenant for row-level security is the ordinary setting app.tenant_id. RLS protects against a forgotten WHERE
-- clause, not against attacker-controlled SQL: a statement running as qenbel_app in tenant A's transaction can
-- select set_config('app.tenant_id', '<B>', true) and then read B's rows.
--
-- The mitigation implemented here (opt-in per database, off until a key is installed):
--   * a secret key lives in tenant_proof_keys. Only qenbel_platform can read it; qenbel_app, qenbel_auth and qenbel_platform_ops cannot;
--   * the API process holds the same key (QENBEL_TENANT_PROOF_KEY) and withTenant() sets, next to app.tenant_id, a second
--     transaction-local setting app.tenant_proof = hex(HMAC-SHA256(key, 'qenbel.tenant:' || tenant_id));
--   * current_tenant_id() is now SECURITY DEFINER: while a key is installed it returns the tenant only if the proof matches
--     (current or previous key), else NULL, which means zero rows and failed WITH CHECKs, exactly as for "no tenant";
--   * SQL that rewrites app.tenant_id cannot produce the proof for another tenant without the key, which never reaches the database
--     from the request path and cannot be read through SQL by the runtime role.
-- With no key installed (the default, and the state of the shared development and test databases) behaviour is unchanged.
--
-- What it does NOT protect against: code that holds the key (the API process); a database administrator; an attacker who can both
-- read the API's memory or environment and run SQL. It does not stop SQL that is run inside the victim tenant's own context.
-- Compensating controls remain: parameterised SQL only, no string-built SQL, no set_config outside withTenant (test/sql-hygiene.test.ts).
--
-- Cost: one HMAC per statement. The policies call current_tenant_id() in a scalar sub-select so it is evaluated once per statement
-- (an InitPlan), not once per row, and the result stays usable as an index condition.


CREATE TABLE tenant_proof_keys (
  slot    text PRIMARY KEY CHECK (slot IN ('current', 'previous')),
  key     bytea NOT NULL CHECK (octet_length(key) >= 32),
  set_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON tenant_proof_keys FROM PUBLIC, qenbel_app, qenbel_auth, qenbel_platform_ops;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_proof_keys TO qenbel_platform;
-- HMAC-SHA256 (RFC 2104) on the built-in sha256(), so no extension is needed. (pgcrypto would be owned by the bootstrap superuser
-- as a trusted extension, and the migration role could not take its functions away from PUBLIC.) Callable only by qenbel_platform.
CREATE FUNCTION app_hmac_sha256(p_key bytea, p_msg bytea) RETURNS bytea
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
DECLARE
  k    bytea := CASE WHEN octet_length(p_key) > 64 THEN sha256(p_key) ELSE p_key END;
  ipad bytea;
  opad bytea;
  b    integer;
BEGIN
  k := k || decode(repeat('00', 64 - octet_length(k)), 'hex');
  ipad := k;
  opad := k;
  FOR i IN 0..63 LOOP
    b := get_byte(k, i);
    ipad := set_byte(ipad, i, b # 54);   -- 0x36
    opad := set_byte(opad, i, b # 92);   -- 0x5c
  END LOOP;
  RETURN sha256(opad || sha256(ipad || p_msg));
END $$;
REVOKE ALL ON FUNCTION app_hmac_sha256(bytea, bytea) FROM PUBLIC, qenbel_app, qenbel_auth, qenbel_platform_ops;
GRANT EXECUTE ON FUNCTION app_hmac_sha256(bytea, bytea) TO qenbel_platform;

-- current_tenant_id(): same name and signature (the policies depend on it), new body, new owner.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE PARALLEL RESTRICTED SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_proof  text;
  v_keys   bytea[];
  v_key    bytea;
  v_want   bytea;
BEGIN
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT array_agg(k.key) INTO v_keys FROM tenant_proof_keys k;
  IF v_keys IS NULL THEN
    RETURN v_tenant;                       -- proof not enabled in this database
  END IF;
  v_proof := lower(nullif(current_setting('app.tenant_proof', true), ''));
  IF v_proof IS NULL THEN
    RETURN NULL;                           -- enabled, and the caller sent no proof: fail closed
  END IF;
  -- Compare digests of the two values, so the comparison time does not depend on how long a guessed prefix is right.
  v_proof := encode(sha256(convert_to(v_proof, 'UTF8')), 'hex');
  FOREACH v_key IN ARRAY v_keys LOOP
    v_want := app_hmac_sha256(v_key, convert_to('qenbel.tenant:' || v_tenant::text, 'UTF8'));
    IF encode(sha256(convert_to(encode(v_want, 'hex'), 'UTF8')), 'hex') = v_proof THEN
      RETURN v_tenant;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

ALTER FUNCTION current_tenant_id() OWNER TO qenbel_platform;

-- Policies: evaluate the function once per statement.
CREATE OR REPLACE FUNCTION app_secure_tenant_table(p_table regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', p_table);
  -- Missing app.tenant_id (or a missing/wrong proof) => current_tenant_id() is NULL => comparison is NULL => no rows, no error.
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = (SELECT current_tenant_id())) WITH CHECK (tenant_id = (SELECT current_tenant_id()))',
    p_table);
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_table AND attname = 'updated_at' AND NOT attisdropped) THEN
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', p_table);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION set_updated_at()', p_table);
  END IF;
END $$;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT c.oid::regclass AS tbl, pol.polname
      FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND pol.polname IN ('tenant_isolation', 'tenant_self')
  LOOP
    IF p.polname = 'tenant_isolation' THEN
      EXECUTE format('ALTER POLICY tenant_isolation ON %s USING (tenant_id = (SELECT current_tenant_id())) WITH CHECK (tenant_id = (SELECT current_tenant_id()))', p.tbl);
    ELSE
      EXECUTE format('ALTER POLICY tenant_self ON %s USING (id = (SELECT current_tenant_id())) WITH CHECK (id = (SELECT current_tenant_id()))', p.tbl);
    END IF;
  END LOOP;
END $$;

-- Operating the key. Executable by qenbel_platform_ops only.
SET LOCAL ROLE qenbel_platform;

CREATE FUNCTION platform_set_tenant_proof_keys(p_current bytea, p_previous bytea DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_current IS NULL OR octet_length(p_current) < 32 THEN
    RAISE EXCEPTION 'tenant proof key must be at least 32 bytes' USING ERRCODE = '22023';
  END IF;
  IF p_previous IS NOT NULL AND octet_length(p_previous) < 32 THEN
    RAISE EXCEPTION 'previous tenant proof key must be at least 32 bytes' USING ERRCODE = '22023';
  END IF;
  DELETE FROM tenant_proof_keys;
  INSERT INTO tenant_proof_keys (slot, key) VALUES ('current', p_current);
  IF p_previous IS NOT NULL THEN
    INSERT INTO tenant_proof_keys (slot, key) VALUES ('previous', p_previous);
  END IF;
END $$;

-- Turns the check off again (rollback of the feature, or a test teardown). Row-level security itself stays on.
CREATE FUNCTION platform_clear_tenant_proof_keys() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ DELETE FROM tenant_proof_keys $$;

CREATE FUNCTION platform_tenant_proof_enabled() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM tenant_proof_keys) $$;

REVOKE ALL ON FUNCTION platform_set_tenant_proof_keys(bytea, bytea), platform_clear_tenant_proof_keys(), platform_tenant_proof_enabled()
  FROM PUBLIC, qenbel_app, qenbel_auth, qenbel_platform_ops;
GRANT EXECUTE ON FUNCTION platform_set_tenant_proof_keys(bytea, bytea), platform_clear_tenant_proof_keys(), platform_tenant_proof_enabled()
  TO qenbel_platform_ops;

RESET ROLE;
