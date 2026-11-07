// Test harness. Tests run against the real Docker Postgres in a database of their own
// (qenbel_admin_api_test) so they never collide with the db package's tests.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Provider, Type } from "@nestjs/common";
import request from "supertest";
import { createPool, resolveDatabaseUrls, runMigrations, withTenant, type Pool } from "@qenbel/db";
import { UserRole } from "@qenbel/shared";
import { createApp, type CreateAppOptions } from "../../src/bootstrap.ts";
import { AppLogger, MemorySink } from "../../src/common/logger.ts";
import { type AppConfig, loadConfig } from "../../src/config/config.ts";
import { InMemoryRateLimiter, type RateLimiter } from "../../src/ratelimit/rate-limiter.ts";

export const API_TEST_DATABASE = process.env.API_TEST_DATABASE ?? "qenbel_admin_api_test";

export interface Db {
  /** qenbel_app: subject to RLS. What the API uses. */
  app: Pool;
  /** qenbel_migrate: owner. Used by tests for setup and for reading across tenants. */
  owner: Pool;
  appUrl: string;
  close(): Promise<void>;
}

export async function connectDb(): Promise<Db> {
  const urls = resolveDatabaseUrls(API_TEST_DATABASE, {});
  const owner = createPool({ connectionString: urls.migrateUrl, max: 4, applicationName: "qenbel-api-test-owner" });
  const app = createPool({ connectionString: urls.appUrl, max: 12, applicationName: "qenbel-api-test-app" });
  try {
    await owner.query("select 1");
  } catch (err) {
    await Promise.allSettled([owner.end(), app.end()]);
    throw new Error(
      `API test database is not reachable (${(err as Error).message}).\n` +
        "Start Postgres:  docker compose -f infra/docker-compose.yml up -d\n" +
        `Create the database once:  docker exec qenbel-admin-db psql -U postgres -c "CREATE DATABASE ${API_TEST_DATABASE} OWNER qenbel_migrate"\n` +
        "then grant as in infra/postgres/init/01-roles-and-databases.sh. These tests are not skipped when the database is down.",
    );
  }
  await runMigrations(owner);
  await owner.query("truncate table tenants, platform_admins cascade");
  return {
    app,
    owner,
    appUrl: urls.appUrl,
    close: async () => {
      await Promise.allSettled([app.end(), owner.end()]);
    },
  };
}

export const TEST_PEPPER = createHash("sha256").update("qenbel-api-test-pepper").digest("hex");

export function devEnv(db: Db, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "development",
    AUTH_PROVIDER: "dev",
    HOST: "127.0.0.1",
    DATABASE_URL: db.appUrl,
    API_KEY_PEPPER: TEST_PEPPER,
    LOG_LEVEL: "silent",
    // tests send many deliberately bad requests from one address; rate-limit tests set their own limits
    RATE_LIMIT_AUTH_FAIL_MAX: "10000",
    RATE_LIMIT_IP_MAX: "100000",
    RATE_LIMIT_PUBLIC_MAX: "100000",
    RATE_LIMIT_PRINCIPAL_MAX: "100000",
    ...extra,
  };
}

export function devConfig(db: Db, extra: Record<string, string> = {}): AppConfig {
  return loadConfig(devEnv(db, extra));
}

export interface TestApp {
  app: NestExpressApplication;
  http: ReturnType<typeof request>;
  config: AppConfig;
  logs: MemorySink;
  limiter: RateLimiter;
  close(): Promise<void>;
  get(path: string, token?: string): request.Test;
  post(path: string, token?: string, body?: unknown): request.Test;
  put(path: string, token?: string, body?: unknown): request.Test;
}

export interface StartOptions extends Partial<Omit<CreateAppOptions, "config">> {
  config?: AppConfig;
  extraControllers?: Type[];
  extraProviders?: Provider[];
}

export async function startApp(db: Db, options: StartOptions = {}): Promise<TestApp> {
  const config = options.config ?? devConfig(db);
  const logs = new MemorySink();
  const logger = options.logger ?? new AppLogger("debug", logs);
  const limiter = options.limiter ?? new InMemoryRateLimiter();
  const app = await createApp({ ...options, config, logger, pool: db.app, limiter });
  const http = request(app.getHttpServer());
  const auth = (t: request.Test, token?: string) => (token ? t.set("Authorization", `Bearer ${token}`) : t);
  return {
    app,
    http,
    config,
    logs,
    limiter,
    close: () => app.close(),
    get: (path, token) => auth(http.get(path), token),
    post: (path, token, body) => {
      const t = auth(http.post(path), token);
      return body === undefined ? t : t.send(body as object);
    },
    put: (path, token, body) => {
      const t = auth(http.put(path), token);
      return body === undefined ? t : t.send(body as object);
    },
  };
}

// ---- data helpers (setup goes through the same paths the product uses where possible) ----

export interface TenantFixture {
  id: string;
  slug: string;
  users: Record<string, { id: string; subject: string; token: string; role: string }>;
}

const rand = () => randomBytes(4).toString("hex");

/** A central tenant with an OWNER, MANAGER and STAFF user. Tokens are dev tokens (dev|subject). */
export async function createTenant(db: Db, name = "t", opts: { pack?: string; roles?: string[] } = {}): Promise<TenantFixture> {
  const slug = `${name}-${rand()}`;
  const res = await db.app.query<{ id: string }>("select platform_create_tenant($1, $2, 'central', $3, '1.0.0') as id", [
    slug,
    `Test ${slug}`,
    opts.pack ?? "salon",
  ]);
  const id = (res.rows[0] as { id: string }).id;
  const users: TenantFixture["users"] = {};
  for (const role of opts.roles ?? [UserRole.OWNER, UserRole.MANAGER, UserRole.STAFF]) {
    users[role] = await addUser(db, id, role, `${slug}-${role.toLowerCase()}`);
  }
  return { id, slug, users };
}

export async function addUser(
  db: Db,
  tenantId: string,
  role: string,
  label: string,
  opts: { provider?: string; subject?: string; disabled?: boolean } = {},
): Promise<{ id: string; subject: string; token: string; role: string }> {
  const subject = opts.subject ?? `dev|${label}`;
  const id = randomUUID();
  await withTenant(db.app, tenantId, (c) =>
    c.query(
      "insert into users (id, tenant_id, auth_provider, external_subject, email, name, role, disabled_at) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, tenantId, opts.provider ?? "dev", subject, `${label}@example.test`.toLowerCase(), `User ${label}`, role, opts.disabled ? new Date() : null],
    ),
  );
  return { id, subject, token: subject, role };
}

export async function addPlatformAdmin(db: Db, subject: string, provider = "dev"): Promise<void> {
  await db.owner.query(
    "insert into platform_admins (auth_provider, external_subject, email, name) values ($1, $2, $3, 'Admin') on conflict do nothing",
    [provider, subject, `${rand()}@example.test`],
  );
}

/** Rows of a tenant's audit log, read as the owner (bypasses nothing: FORCE RLS applies, so we set the tenant). */
export async function auditRows(db: Db, tenantId: string, action?: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(db.owner, tenantId, async (c) => {
    const r = await c.query(
      "select action, outcome, actor_kind, actor_id, entity_type, entity_id, request_id, details from audit_log where ($1::text is null or action = $1) order by seq",
      [action ?? null],
    );
    return r.rows as Array<Record<string, unknown>>;
  });
}

/** Suspend or resume a tenant through the same SECURITY DEFINER function the platform uses. */
export async function setTenantStatus(db: Db, tenantId: string, status: "active" | "suspended" | "archived"): Promise<void> {
  await db.app.query("select platform_set_tenant_status($1, $2)", [tenantId, status]);
}
