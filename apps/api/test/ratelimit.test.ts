import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppLogger, MemorySink } from "../src/common/logger.ts";
import { FallbackRateLimiter, InMemoryRateLimiter, RedisRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { type Db, type TenantFixture, connectDb, createTenant, devConfig, startApp } from "./helpers/harness.ts";
import { TestRoutesController } from "./helpers/test-routes.ts";

describe("in-memory rate limiter", () => {
  it("counts per key within a window and resets after it", async () => {
    let now = 1_000_000;
    const rl = new InMemoryRateLimiter(() => now);
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await rl.hit("k", 3, 60));
    assert.deepEqual(hits.map((h) => h.allowed), [true, true, true, false]);
    assert.deepEqual(hits.map((h) => h.remaining), [2, 1, 0, 0]);
    assert.equal(hits[3]?.resetSeconds, 60);
    assert.equal((await rl.hit("other", 3, 60)).allowed, true, "keys are independent");
    now += 30_000;
    assert.equal((await rl.hit("k", 3, 60)).resetSeconds, 30);
    now += 31_000;
    assert.equal((await rl.hit("k", 3, 60)).remaining, 2, "new window");
  });

  it("peek does not count", async () => {
    const rl = new InMemoryRateLimiter();
    await rl.hit("k", 2, 60);
    await rl.hit("k", 2, 60);
    assert.equal((await rl.peek("k", 2)).allowed, false);
    assert.equal((await rl.peek("k", 2)).allowed, false);
    assert.equal((await rl.peek("fresh", 2)).allowed, true);
  });

  it("memory stays bounded under a flood of distinct keys", async () => {
    const rl = new InMemoryRateLimiter();
    for (let i = 0; i < 60_000; i++) await rl.hit(`ip:${i}`, 10, 60);
    assert.ok(rl.size() <= 50_000, String(rl.size()));
  });
});

describe("redis rate limiter (Docker Redis)", () => {
  // Same local development values the db package reads: infra/.env, never printed.
  const url = (() => {
    const pw = process.env.REDIS_PASSWORD ?? readInfraRedisPassword();
    return `redis://:${encodeURIComponent(pw)}@127.0.0.1:63799`;
  })();

  it("counts atomically across callers, expires, and the fallback takes over when Redis is down", async () => {
    const redis = new RedisRateLimiter(url, { prefix: `qenbel:test:${randomUUID()}:` });
    try {
      const key = "k";
      const results = await Promise.all(Array.from({ length: 10 }, () => redis.hit(key, 4, 2)));
      assert.equal(results.filter((r) => r.allowed).length, 4);
      assert.equal((await redis.peek(key, 4)).allowed, false);
      await new Promise((r) => setTimeout(r, 2200));
      assert.equal((await redis.hit(key, 4, 2)).remaining, 3, "window expired");
    } finally {
      await redis.close();
    }
    const dead = new RedisRateLimiter("redis://127.0.0.1:1", { prefix: "x:" });
    const sink = new MemorySink();
    const fb = new FallbackRateLimiter(dead, new InMemoryRateLimiter(), new AppLogger("warn", sink));
    try {
      const r = await fb.hit("k", 1, 60);
      assert.equal(r.allowed, true);
      assert.equal((await fb.hit("k", 1, 60)).allowed, false, "still limits, in memory");
      assert.ok(sink.lines.some((l) => l.includes("in-memory")));
    } finally {
      await fb.close();
    }
  });
});

function readInfraRedisPassword(): string {
  // infra/.env is git-ignored local configuration.
  process.loadEnvFile(new URL("../../../../infra/.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const pw = process.env.REDIS_PASSWORD;
  if (!pw) throw new Error("REDIS_PASSWORD is not set (infra/.env). The Redis rate limiter test does not skip.");
  return pw;
}

describe("rate limiting over HTTP", () => {
  let db: Db;
  let a: TenantFixture;
  let b: TenantFixture;

  before(async () => {
    db = await connectDb();
    a = await createTenant(db, "rl-a");
    b = await createTenant(db, "rl-b");
  });
  after(async () => {
    await db.close();
  });

  it("public routes are limited per client address, with headers and Retry-After", async () => {
    const api = await startApp(db, { config: devConfig(db, { RATE_LIMIT_PUBLIC_MAX: "3" }) });
    try {
      for (let i = 0; i < 3; i++) {
        const ok = await api.get("/health");
        assert.equal(ok.status, 200);
        assert.equal(ok.headers["ratelimit-limit"], "3");
        assert.equal(ok.headers["ratelimit-remaining"], String(2 - i));
        assert.ok(Number(ok.headers["ratelimit-reset"]) >= 1);
      }
      const blocked = await api.get("/health");
      assert.equal(blocked.status, 429);
      assert.equal(blocked.body.error.code, "RATE_LIMITED");
      assert.deepEqual(Object.keys(blocked.body), ["error"]);
      assert.ok(Number(blocked.headers["retry-after"]) >= 1);
      assert.equal(blocked.headers["ratelimit-remaining"], "0");
    } finally {
      await api.close();
    }
  });

  it("signed-in principals are limited individually: A being throttled does not affect B", async () => {
    const api = await startApp(db, { config: devConfig(db, { RATE_LIMIT_PRINCIPAL_MAX: "3" }) });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await api.get("/v1/me", a.users.OWNER?.token)).status);
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      // B comes from the same address; only the per-principal budget differs.
      assert.equal((await api.get("/v1/me", b.users.OWNER?.token)).status, 200);
      assert.equal((await api.get("/v1/me", a.users.STAFF?.token)).status, 200, "another user of the same tenant has their own budget");
    } finally {
      await api.close();
    }
  });

  it("repeated failed sign-ins lock the address out, even for a valid token", async () => {
    const api = await startApp(db, { config: devConfig(db, { RATE_LIMIT_AUTH_FAIL_MAX: "3" }), extraControllers: [TestRoutesController] });
    try {
      for (let i = 0; i < 3; i++) assert.equal((await api.get("/v1/me", "garbage")).status, 401);
      const locked = await api.get("/v1/me", a.users.OWNER?.token);
      assert.equal(locked.status, 429);
      assert.equal(locked.body.error.code, "RATE_LIMITED");
      assert.equal((await api.get("/health")).status, 200, "public routes are not affected by the sign-in lockout");
    } finally {
      await api.close();
    }
  });
});
