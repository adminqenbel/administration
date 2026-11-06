import { existsSync } from "node:fs";
import path from "node:path";

// Connection settings. Real environment variables win. For local development only, missing values are
// derived from infra/.env (git-ignored): the same POSTGRES_PASSWORD the docker-compose file uses.

export interface DatabaseUrls {
  /** Runtime role (qenbel_app): subject to RLS. Used by the API and by seed. */
  appUrl: string;
  /** Owner role (qenbel_migrate): runs migrations. Never used by request handling. */
  migrateUrl: string;
}

export const DEV_DATABASE = "qenbel_admin";
export const TEST_DATABASE = "qenbel_admin_test";

const INFRA_ENV = path.resolve(import.meta.dirname, "..", "..", "..", "infra", ".env");

function loadInfraEnv(env: NodeJS.ProcessEnv): void {
  if (env.POSTGRES_PASSWORD || !existsSync(INFRA_ENV)) return;
  try {
    // Node >= 20.12. Loads into process.env without overriding values that are already set.
    process.loadEnvFile(INFRA_ENV);
  } catch {
    // unreadable file: fall through to the explicit error below
  }
}

/**
 * Resolve database URLs.
 * - `DATABASE_URL` / `DATABASE_MIGRATE_URL` (or `TEST_DATABASE_URL` / `TEST_DATABASE_MIGRATE_URL` when
 *   `database` is the test database) are used as given.
 * - Otherwise they are built for the docker-compose Postgres on localhost:54329.
 */
export function resolveDatabaseUrls(database: string = DEV_DATABASE, env: NodeJS.ProcessEnv = process.env): DatabaseUrls {
  const isTest = database === TEST_DATABASE;
  const appVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const migrateVar = isTest ? "TEST_DATABASE_MIGRATE_URL" : "DATABASE_MIGRATE_URL";
  const explicitApp = env[appVar];
  const explicitMigrate = env[migrateVar];
  if (explicitApp && explicitMigrate) return { appUrl: explicitApp, migrateUrl: explicitMigrate };

  loadInfraEnv(env);
  const base = process.env.POSTGRES_PASSWORD;
  const host = process.env.QENBEL_DB_HOST ?? "localhost";
  const port = process.env.QENBEL_DB_PORT ?? "54329";
  const appPw = process.env.QENBEL_APP_PASSWORD || base;
  const migPw = process.env.QENBEL_MIGRATE_PASSWORD || base;
  if (!explicitApp && !appPw) {
    throw new Error(`Database not configured: set ${appVar} (or POSTGRES_PASSWORD, for the local docker-compose database).`);
  }
  if (!explicitMigrate && !migPw) {
    throw new Error(`Database not configured: set ${migrateVar} (or POSTGRES_PASSWORD, for the local docker-compose database).`);
  }
  const build = (user: string, pw: string) =>
    `postgres://${user}:${encodeURIComponent(pw)}@${host}:${port}/${database}`;
  return {
    appUrl: explicitApp ?? build("qenbel_app", appPw as string),
    migrateUrl: explicitMigrate ?? build("qenbel_migrate", migPw as string),
  };
}

/** Refuses destructive local-only operations (seed --reset) on anything that does not look like a local dev database. */
export function assertLocalDevDatabase(url: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to run: NODE_ENV=production.");
  }
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to run against non-local database host "${host}".`);
  }
}
