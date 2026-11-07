// HTTP hygiene: headers, request ids, CORS, health, logging, graceful shutdown.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/bootstrap.ts";
import { AppLogger, MemorySink } from "../src/common/logger.ts";
import { closeApp } from "../src/shutdown.ts";
import { InMemoryRateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { type Db, type TenantFixture, type TestApp, connectDb, createTenant, devConfig, startApp } from "./helpers/harness.ts";
import { TestRoutesController } from "./helpers/test-routes.ts";

describe("http hygiene", () => {
  let db: Db;
  let api: TestApp;
  let t: TenantFixture;

  before(async () => {
    db = await connectDb();
    api = await startApp(db, { extraControllers: [TestRoutesController] });
    t = await createTenant(db, "http");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("GET /health and /health/db are public, minimal and carry no version or tenant data", async () => {
    const live = await api.get("/health");
    assert.deepEqual(live.body, { status: "ok" });
    const dbh = await api.get("/health/db");
    assert.equal(dbh.status, 200);
    assert.deepEqual(dbh.body, { status: "ok" });
  });

  it("/health/db reports 503 with a generic body when the database is down", async () => {
    const broken = await startApp(db, {
      pool: { query: async () => { throw new Error("connect ECONNREFUSED 10.1.2.3:5432 password=hunter2"); }, end: async () => undefined } as never,
    });
    try {
      const res = await broken.get("/health/db");
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "SERVICE_UNAVAILABLE");
      assert.ok(!JSON.stringify(res.body).includes("10.1.2.3"));
      assert.equal((await broken.get("/health")).status, 200, "liveness does not depend on the database");
    } finally {
      await broken.app.close();
    }
  });

  it("every response carries security headers; nothing reveals the framework", async () => {
    for (const res of [await api.get("/health"), await api.get("/v1/me"), await api.get("/nope")]) {
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.headers["x-frame-options"], "DENY");
      assert.equal(res.headers["referrer-policy"], "no-referrer");
      assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["x-powered-by"], undefined);
      assert.equal(res.headers["etag"], undefined);
    }
  });

  it("request ids: generated, echoed when well-formed, replaced when not", async () => {
    const generated = await api.get("/health");
    assert.match(String(generated.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    const echoed = await api.http.get("/health").set("X-Request-Id", "trace-abc12345");
    assert.equal(echoed.headers["x-request-id"], "trace-abc12345");
    const evil = await api.http.get("/health").set("X-Request-Id", "bad id with spaces <script>");
    assert.notEqual(evil.headers["x-request-id"], "bad id with spaces <script>");
    assert.match(String(evil.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });

  it("CORS allows the web app origin only, without credentials", async () => {
    const web = api.config.publicWebOrigin;
    const ok = await api.http.get("/health").set("Origin", web);
    assert.equal(ok.headers["access-control-allow-origin"], web);
    assert.equal(ok.headers["access-control-allow-credentials"], undefined);
    const evil = await api.http.get("/health").set("Origin", "https://evil.example.test");
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    const pre = await api.http.options("/v1/business/profile").set("Origin", web).set("Access-Control-Request-Method", "PUT");
    assert.equal(pre.status, 204);
    assert.match(String(pre.headers["access-control-allow-headers"]), /Idempotency-Key/);
    const preEvil = await api.http.options("/v1/business/profile").set("Origin", "https://evil.example.test");
    assert.equal(preEvil.status, 204);
    assert.equal(preEvil.headers["access-control-allow-origin"], undefined);
  });

  it("access log has method, route, status, duration and request id, and no secrets", async () => {
    api.logs.lines.length = 0;
    const token = t.users.OWNER?.token ?? "";
    await api.http.get("/v1/me?note=top-secret-query").set("Authorization", `Bearer ${token}`);
    await api.http.get("/v1/me").set("Authorization", "Bearer qbk_AAAAAAAAAAAA.SECRETSECRETSECRETSECRETSECRETSECRETSECRE");
    await api.http.get("/v1/test/boom");
    const text = api.logs.lines.join("\n");
    for (const secret of [token, "top-secret-query", "SECRETSECRET", "hunter2", "u:pw@", "Bearer "]) assert.ok(!text.includes(secret), `log contains ${secret}`);
    const rec = api.logs.records().find((r) => r.msg === "request" && r.route === "/v1/me" && r.status === 200);
    assert.ok(rec, "request line");
    assert.equal(rec.method, "GET");
    assert.equal(typeof rec.durationMs, "number");
    assert.equal(typeof rec.requestId, "string");
    assert.equal(rec.tenantId, t.id);
  });

  it("graceful shutdown: in-flight requests finish, new connections are refused, resources are closed", async () => {
    const sink = new MemorySink();
    const logger = new AppLogger("debug", sink);
    const app = await createApp({ config: devConfig(db), logger, pool: db.app, limiter: new InMemoryRateLimiter(), extraControllers: [TestRoutesController] });
    await app.listen(0, "127.0.0.1");
    const port = (app.getHttpServer().address() as { port: number }).port;
    const slow = fetch(`http://127.0.0.1:${port}/v1/test/slow/400`).then(async (r) => ({ status: r.status, body: await r.json() }));
    await new Promise((r) => setTimeout(r, 100));
    await closeApp(app, logger, 5_000);
    assert.deepEqual(await slow, { status: 200, body: { done: true } });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    assert.ok(sink.lines.some((l) => l.includes("resources closed")));
    assert.equal((await db.app.query("select 1 as ok")).rows[0].ok, 1, "a pool the app does not own is left open");
  });

  it("the app ends a pool it created itself on close", async () => {
    const app = await createApp({
      config: devConfig(db),
      logger: new AppLogger("silent"),
      limiter: new InMemoryRateLimiter(),
    });
    // The pool was created from DATABASE_URL by the app; closing the app must end it without hanging.
    const started = Date.now();
    await app.close();
    const took = Date.now() - started;
    assert.ok(took < 3000, `close took ${took} ms`);
  });
});
