#!/bin/sh
# Least-privilege LOGIN roles for the two things that must not run as the request role (docs/security SEC-002):
#
#   qenbel_auth          resolves a verified identity or an API key to a tenant. Can execute ONLY
#                        auth_lookup_user, auth_lookup_credential, auth_is_platform_admin (migration 017).
#                        No table privileges at all.
#   qenbel_platform_ops  platform and worker work. Can execute ONLY platform_create_tenant(_with_owner),
#                        platform_set_tenant_status, platform_list_active_tenants, expire_booking_holds,
#                        purge_expired_idempotency_keys, platform_set_tenant_proof_keys. No table privileges at all.
#
# Idempotent. Runs in two ways, both as the postgres superuser inside the database container:
#   * automatically, on first start of an empty data volume (docker-entrypoint-initdb.d, after 01-roles-and-databases.sh);
#   * on demand against an already-running container: infra/postgres/apply-roles.sh [database ...]
#
# Passwords come from QENBEL_AUTH_PASSWORD and QENBEL_PLATFORM_OPS_PASSWORD. If one is unset it falls back to
# POSTGRES_PASSWORD with a warning (local development only). Set QENBEL_REQUIRE_DISTINCT_PASSWORDS=1 to make that an error.
# Databases: the arguments, else qenbel_admin, qenbel_admin_test, qenbel_admin_api_test. Missing databases are skipped.
# The roles are cluster-wide; the per-database part is CONNECT and USAGE on schema public. Function EXECUTE grants
# are made by migration 017 (the migration fails loudly if these roles do not exist).
set -eu

PSQL_USER="${PGUSER:-postgres}"
BASE_PW="${POSTGRES_PASSWORD:-}"
AUTH_PW="${QENBEL_AUTH_PASSWORD:-}"
OPS_PW="${QENBEL_PLATFORM_OPS_PASSWORD:-}"

warn_or_fail() {
  if [ "${QENBEL_REQUIRE_DISTINCT_PASSWORDS:-0}" = "1" ]; then
    echo "02-app-roles: $1 is not set and QENBEL_REQUIRE_DISTINCT_PASSWORDS=1" >&2
    exit 1
  fi
  echo "02-app-roles: WARNING $1 is not set; using POSTGRES_PASSWORD (acceptable for local development only)" >&2
}

if [ -z "$AUTH_PW" ]; then warn_or_fail QENBEL_AUTH_PASSWORD; AUTH_PW="$BASE_PW"; fi
if [ -z "$OPS_PW" ]; then warn_or_fail QENBEL_PLATFORM_OPS_PASSWORD; OPS_PW="$BASE_PW"; fi
if [ -z "$AUTH_PW" ] || [ -z "$OPS_PW" ]; then
  echo "02-app-roles: no password available (set QENBEL_AUTH_PASSWORD / QENBEL_PLATFORM_OPS_PASSWORD or POSTGRES_PASSWORD)" >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then DBS="$*"; else DBS="qenbel_admin qenbel_admin_test qenbel_admin_api_test"; fi

psql -v ON_ERROR_STOP=1 --username "$PSQL_USER" --dbname postgres -v auth_pw="$AUTH_PW" -v ops_pw="$OPS_PW" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', r)
  FROM (VALUES ('qenbel_auth'), ('qenbel_platform_ops')) v(r)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r)
\gexec

-- Re-asserted on every run, so the attributes cannot drift.
ALTER ROLE qenbel_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'auth_pw';
ALTER ROLE qenbel_platform_ops LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'ops_pw';

-- Short leashes: a lookup is one indexed read; platform work is a sweep or a tenant insert.
ALTER ROLE qenbel_auth SET statement_timeout = '5s';
ALTER ROLE qenbel_auth SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE qenbel_platform_ops SET statement_timeout = '60s';
ALTER ROLE qenbel_platform_ops SET idle_in_transaction_session_timeout = '30s';

-- Neither role may be a member of, or have members in, any other role (no SET ROLE path to the owner or definer roles).
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s in %s', pg_get_userbyid(m.member), pg_get_userbyid(m.roleid)), ', ') INTO bad
    FROM pg_auth_members m
   WHERE pg_get_userbyid(m.member) IN ('qenbel_auth', 'qenbel_platform_ops', 'qenbel_app')
      OR pg_get_userbyid(m.roleid) IN ('qenbel_auth', 'qenbel_platform_ops', 'qenbel_app');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected role membership: %', bad;
  END IF;
END $$;
SQL

for db in $DBS; do
  exists=$(echo "SELECT 1 FROM pg_database WHERE datname = :'db'" | psql -At --username "$PSQL_USER" --dbname postgres -v db="$db")
  if [ "$exists" != "1" ]; then
    echo "02-app-roles: database $db does not exist, skipped"
    continue
  fi
  # $db comes from the operator's command line; quote it as an identifier for psql.
  psql -v ON_ERROR_STOP=1 --username "$PSQL_USER" --dbname "$db" -v db="$db" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO qenbel_auth, qenbel_platform_ops', :'db') \gexec
GRANT USAGE ON SCHEMA public TO qenbel_auth, qenbel_platform_ops;
SQL
  echo "02-app-roles: $db ready"
done
echo "02-app-roles: roles qenbel_auth and qenbel_platform_ops are in place"
