-- 020: one external identity = at most one active membership, and a deterministic lookup (docs/security/REVIEW-stage2.md SEC-013).
--
-- Rule chosen (simplest safe design): one person belongs to ONE business at a time. `(auth_provider, external_subject)` is unique among
-- users that are not disabled, across all tenants. A person who must work for two businesses needs two sign-in identities.
-- The alternative (multi-membership with a tenant picker) needs a tenant id from the client, which CLAUDE.md forbids.
--
-- What this fixes: the same Clerk subject in two tenants made auth_lookup_user return two rows and the API took rows[0] with no ORDER BY.
-- What it does NOT fix: an owner who knows a person's Clerk id can still add that person (before the person joins any business) and so
-- bind them to the owner's tenant. That needs the invitation flow in apps/api: bind a subject only after the invitee proves control of
-- the invited e-mail. The unique index also means "add member" fails with 23505 (constraint users_identity_active_unique) when the
-- subject is already a member of another business; the API must map it to a neutral CONFLICT that does not say where (it is a
-- membership oracle).
--
-- Existing data: where an identity has several active memberships, the oldest (created_at, id) is kept; the others are disabled
-- (disabled_at = now()) and an audit_log row 'users.duplicate_identity_disabled' is written in the affected tenant.

ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log NO FORCE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT id, tenant_id,
         row_number() OVER w AS rn,
         first_value(id) OVER w AS kept_id
    FROM users
   WHERE disabled_at IS NULL
  WINDOW w AS (PARTITION BY auth_provider, external_subject ORDER BY created_at, id)
), disabled AS (
  UPDATE users u SET disabled_at = now()
    FROM ranked r
   WHERE u.id = r.id AND r.rn > 1
  RETURNING u.id, u.tenant_id, r.kept_id
)
INSERT INTO audit_log (tenant_id, actor_kind, action, entity_type, entity_id, outcome, details)
SELECT tenant_id, 'system', 'users.duplicate_identity_disabled', 'user', id::text, 'success',
       jsonb_build_object('keptUserId', kept_id, 'reason', 'SEC-013 migration 020')
  FROM disabled;

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX users_identity_active_unique ON users (auth_provider, external_subject) WHERE disabled_at IS NULL;

-- Same signature and columns; deterministic and bounded. Ownership is qenbel_platform, so the migration role steps into it.
SET LOCAL ROLE qenbel_platform;

CREATE OR REPLACE FUNCTION auth_lookup_user(p_provider text, p_subject text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, role text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT u.id, u.tenant_id, u.role, u.name
      FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.auth_provider = p_provider AND u.external_subject = p_subject
       AND u.disabled_at IS NULL AND t.status = 'active'
     ORDER BY u.created_at, u.id
     LIMIT 1
  $$;

RESET ROLE;
