import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuthProviderKind } from "@qenbel/shared";
import { ConfigError, assertSafeAuthConfig, describeConfig, loadConfig } from "../src/config/config.ts";
import { createDevProvider } from "../src/auth/dev.provider.ts";
import { createApp } from "../src/bootstrap.ts";

const PEPPER = "p".repeat(40);
const base = {
  NODE_ENV: "development",
  AUTH_PROVIDER: "dev",
  HOST: "127.0.0.1",
  DATABASE_URL: "postgres://qenbel_app:very-secret-db-password@localhost:54329/x",
  API_KEY_PEPPER: PEPPER,
};

function issues(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return [...err.issues];
  }
  return [];
}

describe("config", () => {
  it("loads a development config with defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.nodeEnv, "development");
    assert.equal(c.deploymentMode, "central");
    assert.equal(c.port, 4000);
    assert.equal(c.bodyLimitBytes, 256 * 1024);
    assert.equal(c.authProvider, AuthProviderKind.DEV);
    assert.ok(Object.isFrozen(c));
  });

  it("fails fast and lists every problem by variable name", () => {
    const found = issues({ NODE_ENV: "production" });
    assert.ok(found.some((m) => m.startsWith("DATABASE_URL")));
    assert.ok(found.some((m) => m.startsWith("API_KEY_PEPPER")));
    assert.ok(found.some((m) => m.startsWith("PUBLIC_API_ORIGIN")));
    assert.ok(found.some((m) => m.startsWith("CLERK_JWT_KEY")));
    assert.ok(found.some((m) => m.startsWith("CLERK_ISSUER")));
  });

  it("never puts values in error messages", () => {
    const found = issues({ ...base, API_KEY_PEPPER: "short-secret-value", PORT: "not-a-number-secret", REDIS_URL: "http://user:redis-pass@h" }).join("\n");
    assert.ok(found.length > 0);
    for (const secret of ["short-secret-value", "not-a-number-secret", "redis-pass", "very-secret-db-password"]) {
      assert.ok(!found.includes(secret), `message leaked ${secret}`);
    }
  });

  it("treats an unset NODE_ENV as production", () => {
    const { NODE_ENV: _omit, ...env } = base;
    const c = issues(env);
    assert.ok(c.some((m) => m.includes("AUTH_PROVIDER=dev is allowed only when NODE_ENV=development")));
  });

  it("refuses the dev auth provider unless NODE_ENV=development", () => {
    for (const nodeEnv of ["production", "test"]) {
      const found = issues({ ...base, NODE_ENV: nodeEnv });
      assert.ok(found.some((m) => m.includes("NODE_ENV=development")), nodeEnv);
    }
  });

  it("refuses the dev auth provider when not bound to loopback", () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "api.example.com"]) {
      const found = issues({ ...base, HOST: host });
      assert.ok(found.some((m) => m.includes("loopback")), host);
    }
    for (const host of ["127.0.0.1", "::1", "localhost"]) assert.deepEqual(issues({ ...base, HOST: host }), [], host);
  });

  it("requires https origins in production and rejects paths and credentials", () => {
    const prod = { ...base, NODE_ENV: "production", AUTH_PROVIDER: "clerk", CLERK_JWT_KEY: "x", CLERK_ISSUER: "https://x.clerk.accounts.dev" };
    assert.ok(issues({ ...prod, PUBLIC_API_ORIGIN: "http://api.example.com", PUBLIC_WEB_ORIGIN: "https://app.example.com" }).some((m) => m.includes("https in production")));
    assert.ok(issues({ ...base, PUBLIC_API_ORIGIN: "http://localhost:4000/path" }).some((m) => m.startsWith("PUBLIC_API_ORIGIN")));
    assert.ok(issues({ ...base, PUBLIC_API_ORIGIN: "http://user:pw@localhost:4000" }).some((m) => m.startsWith("PUBLIC_API_ORIGIN")));
  });

  it("clerk needs a valid public key and an issuer", () => {
    const found = issues({ ...base, NODE_ENV: "test", AUTH_PROVIDER: "clerk", CLERK_JWT_KEY: "not a key", CLERK_ISSUER: "https://x.clerk.accounts.dev" });
    assert.ok(found.some((m) => m.includes("CLERK_JWT_KEY must be a PEM public key")));
  });

  it("isolated mode needs exactly one tenant id from configuration", () => {
    assert.ok(issues({ ...base, DEPLOYMENT_MODE: "isolated" }).some((m) => m.startsWith("ISOLATED_TENANT_ID is required")));
    assert.ok(issues({ ...base, DEPLOYMENT_MODE: "isolated", ISOLATED_TENANT_ID: "nope" }).some((m) => m.includes("UUID")));
    const id = randomUUID();
    const c = loadConfig({ ...base, DEPLOYMENT_MODE: "isolated", ISOLATED_TENANT_ID: id });
    assert.equal(c.isolatedTenantId, id);
    assert.ok(issues({ ...base, ISOLATED_TENANT_ID: id }).some((m) => m.includes("only valid when DEPLOYMENT_MODE=isolated")));
  });

  it("requires a long API_KEY_PEPPER", () => {
    assert.ok(issues({ ...base, API_KEY_PEPPER: "short" }).some((m) => m.includes("at least 32")));
  });

  it("describeConfig leaves out secrets and connection strings", () => {
    const text = JSON.stringify(describeConfig(loadConfig({ ...base, REDIS_URL: "redis://:redis-pass@localhost:63799" })));
    for (const secret of [PEPPER, "very-secret-db-password", "redis-pass", "DATABASE_URL"]) assert.ok(!text.includes(secret), secret);
  });
});

describe("dev auth provider cannot be switched on outside local development", () => {
  const prodLike = { nodeEnv: "production", host: "127.0.0.1" } as const;

  it("createDevProvider throws unless NODE_ENV=development and HOST is loopback", () => {
    assert.throws(() => createDevProvider(prodLike), /NODE_ENV=development/);
    assert.throws(() => createDevProvider({ nodeEnv: "test", host: "127.0.0.1" }), /NODE_ENV=development/);
    assert.throws(() => createDevProvider({ nodeEnv: "development", host: "0.0.0.0" }), /loopback/);
    assert.equal(createDevProvider({ nodeEnv: "development", host: "127.0.0.1" }).kind, "dev");
  });

  it("assertSafeAuthConfig rejects a hand-built unsafe config", () => {
    const good = loadConfig(base);
    assert.doesNotThrow(() => assertSafeAuthConfig(good));
    assert.throws(() => assertSafeAuthConfig({ ...good, nodeEnv: "production" }), ConfigError);
    assert.throws(() => assertSafeAuthConfig({ ...good, host: "0.0.0.0" }), ConfigError);
  });

  it("createApp refuses to start with the dev provider in production, before touching the database", async () => {
    const good = loadConfig(base);
    await assert.rejects(createApp({ config: { ...good, nodeEnv: "production" } }), ConfigError);
    await assert.rejects(createApp({ config: { ...good, host: "0.0.0.0" } }), ConfigError);
  });
});
