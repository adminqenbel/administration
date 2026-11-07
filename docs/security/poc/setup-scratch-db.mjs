// Creates the scratch database used by the security PoCs: qenbel_admin_sec_test.
// Mirrors infra/postgres/init/01-roles-and-databases.sh for one extra database. Idempotent.
// Never touches other databases. Reads POSTGRES_PASSWORD from the environment or infra/.env; prints no secrets.
// Run:  node docs/security/poc/setup-scratch-db.mjs [--reset]   (--reset drops and recreates ONLY this scratch database)
import { existsSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const DB = "qenbel_admin_sec_test";
const infraEnv = path.resolve(import.meta.dirname, "..", "..", "..", "infra", ".env");
if (!process.env.POSTGRES_PASSWORD && existsSync(infraEnv)) process.loadEnvFile(infraEnv);
if (!process.env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD is not set (environment or infra/.env)");

const host = process.env.QENBEL_DB_HOST ?? "localhost";
const port = Number(process.env.QENBEL_DB_PORT ?? "54329");
const connect = (database) =>
  new pg.Client({ host, port, user: "postgres", password: process.env.POSTGRES_PASSWORD, database });

const admin = connect("postgres");
await admin.connect();
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
await db.query(`GRANT CONNECT ON DATABASE ${DB} TO qenbel_migrate, qenbel_app`);
await db.query("CREATE EXTENSION IF NOT EXISTS btree_gist");
await db.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
await db.query("GRANT ALL ON SCHEMA public TO qenbel_migrate");
await db.query("GRANT USAGE ON SCHEMA public TO qenbel_app, qenbel_platform");
await db.query("GRANT CREATE ON SCHEMA public TO qenbel_platform");
await db.end();
console.log("scratch database ready");
