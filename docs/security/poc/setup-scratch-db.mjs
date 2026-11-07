// Creates a scratch database for the security PoCs and the db security-fix tests. Default: qenbel_admin_sec_test.
// Mirrors infra/postgres/init/01-roles-and-databases.sh (+ 02-app-roles.sh) for one extra database. Idempotent.
// Never touches other databases. Reads POSTGRES_PASSWORD from the environment or infra/.env; prints no secrets.
//
// Run:  node docs/security/poc/setup-scratch-db.mjs [--reset] [--name=qenbel_admin_secfix_test]
//   --reset  drops and recreates ONLY the named scratch database
//   --name   another scratch database; must match qenbel_admin_<anything>_test and must not be a shared database
//
// The cluster-wide roles qenbel_auth and qenbel_platform_ops must exist first (they are created by
// `sh infra/postgres/apply-roles.sh <database>`; run that once, it is idempotent).
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const SHARED = new Set(["qenbel_admin", "qenbel_admin_test", "qenbel_admin_api_test", "qenbel_admin_orders_test"]);
const nameArg = process.argv.find((a) => a.startsWith("--name="))?.slice("--name=".length);
const DB = nameArg ?? "qenbel_admin_sec_test";
if (!/^qenbel_admin_[a-z0-9_]*test$/.test(DB) || SHARED.has(DB)) {
  throw new Error(`refusing: "${DB}" is not an allowed scratch database name (qenbel_admin_<x>_test, not a shared database)`);
}
const infraEnv = path.resolve(import.meta.dirname, "..", "..", "..", "infra", ".env");
if (!process.env.POSTGRES_PASSWORD && existsSync(infraEnv)) process.loadEnvFile(infraEnv);
if (!process.env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD is not set (environment or infra/.env)");

const host = process.env.QENBEL_DB_HOST ?? "localhost";
const port = Number(process.env.QENBEL_DB_PORT ?? "54329");
const connect = (database) =>
  new pg.Client({ host, port, user: "postgres", password: process.env.POSTGRES_PASSWORD, database });

const admin = connect("postgres");
await admin.connect();
const roles = await admin.query("select rolname from pg_roles where rolname in ('qenbel_auth', 'qenbel_platform_ops')");
if (roles.rowCount !== 2) {
  await admin.end();
  throw new Error("roles qenbel_auth / qenbel_platform_ops are missing: run `sh infra/postgres/apply-roles.sh " + DB + "` once (it only creates roles; the grants below are made here)");
}
if (process.argv.includes("--reset")) {
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  console.log(`dropped ${DB}`);
}
const exists = await admin.query("select 1 from pg_database where datname = $1", [DB]);
if (exists.rowCount === 0) {
  await admin.query(`CREATE DATABASE ${DB} OWNER qenbel_migrate`);
  console.log(`created ${DB}`);
} else {
  console.log(`${DB} already exists`);
}
await admin.end();

const db = connect(DB);
await db.connect();
await db.query(`REVOKE CONNECT ON DATABASE ${DB} FROM PUBLIC`);
await db.query(`GRANT CONNECT ON DATABASE ${DB} TO qenbel_migrate, qenbel_app, qenbel_auth, qenbel_platform_ops`);
await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
await db.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
await db.query("GRANT ALL ON SCHEMA public TO qenbel_migrate");
await db.query("GRANT USAGE ON SCHEMA public TO qenbel_app, qenbel_platform, qenbel_auth, qenbel_platform_ops");
await db.query("GRANT CREATE ON SCHEMA public TO qenbel_platform");
await db.end();
console.log("scratch database ready: " + DB);
