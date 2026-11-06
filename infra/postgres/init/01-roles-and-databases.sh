#!/bin/sh
# Runs once, on first start of an empty data volume, as the postgres superuser.
# Creates the three QenBel roles and two databases (dev: qenbel_admin, tests: qenbel_admin_test).
#
#   qenbel_migrate   owns the schema, runs migrations. LOGIN. Not superuser. Subject to FORCE RLS.
#   qenbel_app       runtime role. LOGIN, NOBYPASSRLS, no ownership, DML grants only.
#   qenbel_platform  owns a handful of SECURITY DEFINER functions (tenant creation, credential lookup,
#                    cross-tenant hold sweep). BYPASSRLS, NOLOGIN by default. Nothing connects as it.
set -eu

APP_PW="${QENBEL_APP_PASSWORD:-$POSTGRES_PASSWORD}"
MIG_PW="${QENBEL_MIGRATE_PASSWORD:-$POSTGRES_PASSWORD}"
PLAT_PW="${QENBEL_PLATFORM_PASSWORD:-$POSTGRES_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  -v app_pw="$APP_PW" -v mig_pw="$MIG_PW" -v plat_pw="$PLAT_PW" <<'SQL'
CREATE ROLE qenbel_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'mig_pw';
CREATE ROLE qenbel_app     LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_pw';
CREATE ROLE qenbel_platform NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
-- the migrate role must be able to hand function ownership to qenbel_platform
GRANT qenbel_platform TO qenbel_migrate WITH INHERIT FALSE, SET TRUE;
CREATE DATABASE qenbel_admin      OWNER qenbel_migrate;
CREATE DATABASE qenbel_admin_test OWNER qenbel_migrate;
SQL

for db in qenbel_admin qenbel_admin_test; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" <<SQL
REVOKE CONNECT ON DATABASE $db FROM PUBLIC;
GRANT CONNECT ON DATABASE $db TO qenbel_migrate, qenbel_app;
CREATE EXTENSION IF NOT EXISTS btree_gist;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO qenbel_migrate;
GRANT USAGE ON SCHEMA public TO qenbel_app, qenbel_platform;
GRANT CREATE ON SCHEMA public TO qenbel_platform;
SQL
done
