import { existsSync } from "node:fs";
import path from "node:path";

// Connection settings. Real environment variables win. For local development only, missing values are
// derived from infra/.env (git-ignored): the same POSTGRES_PASSWORD the docker-compose file uses.

export interface DatabaseUrls {
  /** Runtime role (qenbel_app): subject to RLS. Request and tenant work only. */
  appUrl: string;
  /** Owner role (qenbel_migrate): runs migrations. Never used by request handling. */
  migrateUrl: string;
  /**
   * Authentication lookups (qenbel_auth): may execute only auth_lookup_user, auth_lookup_credential and
   * auth_is_platform_admin, and has no table privilege. Env: DATABASE_AUTH_URL (tests: TEST_DATABASE_AUTH_URL).
   * Null when it cannot be derived.
   */
  authUrl: string | null;
  /**
   * Platform and worker work (qenbel_platform_ops): tenant creation and status, tenant listing, the cross-tenant hold
   * sweep and the idempotency purge. Env: DATABASE_PLATFORM_URL (tests: TEST_DATABASE_PLATFORM_URL). Null when it cannot be derived.
   */
  platformUrl: string | null;
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
 * - `DATABASE_AUTH_URL` and `DATABASE_PLATFORM_URL` (tests: `TEST_DATABASE_AUTH_URL`, `TEST_DATABASE_PLATFORM_URL`) are used as
 *   given; otherwise they reuse the app URL's host, port and database with the least-privilege role and its password
 *   (`QENBEL_AUTH_PASSWORD`, `QENBEL_PLATFORM_OPS_PASSWORD`, else the local development `POSTGRES_PASSWORD`).
 * - Otherwise everything is built for the docker-compose Postgres on localhost:54329.
 */
export function resolveDatabaseUrls(database: string = DEV_DATABASE, env: NodeJS.ProcessEnv = process.env): DatabaseUrls {
  const isTest = database === TEST_DATABASE;
  const appVar = isTest ? "TEST_DATABASE_URL" : "DATABASE_URL";
  const migrateVar = isTest ? "TEST_DATABASE_MIGRATE_URL" : "DATABASE_MIGRATE_URL";
  const authVar = isTest ? "TEST_DATABASE_AUTH_URL" : "DATABASE_AUTH_URL";
  const platformVar = isTest ? "TEST_DATABASE_PLATFORM_URL" : "DATABASE_PLATFORM_URL";
  const explicitApp = env[appVar];
  const explicitMigrate = env[migrateVar];
  const explicitAuth = env[authVar];
  const explicitPlatform = env[platformVar];

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
  const appUrl = explicitApp ?? build("qenbel_app", appPw as string);
  const sibling = (user: string, pw: string | undefined): string | null => {
    if (!pw) return null;
    try {
      const u = new URL(appUrl);
      u.username = user;
      u.password = pw; // the setter percent-encodes
      return u.toString();
    } catch {
      return null;
    }
  };
  return {
    appUrl,
    migrateUrl: explicitMigrate ?? build("qenbel_migrate", migPw as string),
    authUrl: explicitAuth ?? sibling("qenbel_auth", process.env.QENBEL_AUTH_PASSWORD || base),
    platformUrl: explicitPlatform ?? sibling("qenbel_platform_ops", process.env.QENBEL_PLATFORM_OPS_PASSWORD || base),
  };
}

/** Like resolveDatabaseUrls but throws a clear error when the least-privilege URLs cannot be derived. */
export function requireLeastPrivilegeUrls(urls: DatabaseUrls): { authUrl: string; platformUrl: string } {
  if (!urls.authUrl || !urls.platformUrl) {
    throw new Error(
      "DATABASE_AUTH_URL and DATABASE_PLATFORM_URL are not configured (and could not be derived from the app URL). " +
        "Create the roles with infra/postgres/apply-roles.sh and set both URLs (see infra/README.md).",
    );
  }
  return { authUrl: urls.authUrl, platformUrl: urls.platformUrl };
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
