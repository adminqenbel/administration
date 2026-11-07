-- 018: bind idempotency rows to the principal that created them (docs/security/REVIEW-stage2.md SEC-010).
--
-- Before: UNIQUE (tenant_id, key, route). A second credential of the same tenant that repeated another credential's key
-- (keys such as "call-<call id>-hold-1" are predictable) was handed that credential's stored response, or learned from an
-- IDEMPOTENCY_CONFLICT that the key exists.
--
-- Now every row carries `principal`, filled from the transaction setting app.principal (withTenant(..., { principal })),
-- and a RESTRICTIVE row-level policy makes a row visible and writable only to the principal that owns it:
--   * uniqueness is per (tenant, principal, key, route): two principals may use the same key text independently;
--   * a replay by another principal is simply a miss (it creates its own row), never a replay and never a conflict;
--   * callers need no code change to keep working: the constraint keeps its name (idempotency_keys_unique_key), so the engines'
--     and the API's "insert ... on conflict on constraint idempotency_keys_unique_key" and "select ... where tenant_id, key, route"
--     behave as before, scoped by the policy.
-- Principal format (validated by withTenant): "user:<uuid>" or "credential:<uuid>", optionally with a suffix such as
-- "/conv:<id>" for a channel conversation. Callers that set no principal get '' and see only '' rows (the pre-018 rows).
-- Existing rows are kept with principal '' and expire within 24 h; only a caller without a principal can replay them.

CREATE FUNCTION current_principal() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT coalesce(nullif(current_setting('app.principal', true), ''), '') $$;

-- Policies and column defaults are evaluated with the caller's privileges.
GRANT EXECUTE ON FUNCTION current_principal() TO qenbel_app;

ALTER TABLE idempotency_keys
  ADD COLUMN principal text NOT NULL DEFAULT current_principal()
    CHECK (char_length(principal) <= 200 AND principal ~ '^[A-Za-z0-9_:./-]*$');

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_unique_key;
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_unique_key UNIQUE (tenant_id, principal, key, route);

CREATE POLICY principal_binding ON idempotency_keys AS RESTRICTIVE
  USING (principal = current_principal())
  WITH CHECK (principal = current_principal());
