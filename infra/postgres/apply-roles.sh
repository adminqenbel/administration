#!/bin/sh
# Apply the least-privilege database roles (qenbel_auth, qenbel_platform_ops) to an ALREADY RUNNING Postgres container.
# The init scripts only run on the first start of an empty data volume, so existing environments need this.
# Idempotent: safe to run again (it also rotates the two passwords to the values in infra/.env).
#
#   sh infra/postgres/apply-roles.sh                         # qenbel_admin, qenbel_admin_test, qenbel_admin_api_test
#   sh infra/postgres/apply-roles.sh qenbel_admin_secfix_test  # only the named databases
#
# It runs init/02-app-roles.sh inside the container as the postgres superuser (local socket, no password on the
# command line: the two passwords are passed by NAME with `docker exec -e` and read from your environment or infra/.env).
# Then run the migrations (`npm run migrate -w @qenbel/db`): migration 017 makes the EXECUTE grants.
#
# Environment: QENBEL_DB_CONTAINER (default qenbel-admin-db); QENBEL_REQUIRE_DISTINCT_PASSWORDS=1 refuses to fall back to
# POSTGRES_PASSWORD; QENBEL_APPLY_ROLES_LOCAL=1 runs psql from your PATH instead of docker exec (PGHOST, PGPORT, PGUSER, PGPASSWORD).
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
envfile="$here/../.env"

# Read NAME from the environment, else from infra/.env (parsed, never sourced).
load() {
  name="$1"
  eval "cur=\${$name:-}"
  if [ -z "$cur" ] && [ -f "$envfile" ]; then
    val=$(grep -E "^$name=" "$envfile" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//" || true)
    if [ -n "$val" ]; then export "$name=$val"; fi
  fi
}
load POSTGRES_PASSWORD
load QENBEL_AUTH_PASSWORD
load QENBEL_PLATFORM_OPS_PASSWORD
load QENBEL_REQUIRE_DISTINCT_PASSWORDS

if [ "${QENBEL_APPLY_ROLES_LOCAL:-0}" = "1" ]; then
  exec sh "$here/init/02-app-roles.sh" "$@"
fi

container="${QENBEL_DB_CONTAINER:-qenbel-admin-db}"
# MSYS_NO_PATHCONV stops Git Bash on Windows from rewriting the /docker-entrypoint-initdb.d path.
MSYS_NO_PATHCONV=1 exec docker exec -i \
  -e POSTGRES_PASSWORD -e QENBEL_AUTH_PASSWORD -e QENBEL_PLATFORM_OPS_PASSWORD -e QENBEL_REQUIRE_DISTINCT_PASSWORDS \
  "$container" sh /docker-entrypoint-initdb.d/02-app-roles.sh "$@"
