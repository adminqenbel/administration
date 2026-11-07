import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "@qenbel/db";
import { requestHash } from "../src/idempotency/idempotency.service.ts";
import { type Db, type TenantFixture, type TestApp, connectDb, createTenant, devConfig, startApp } from "./helpers/harness.ts";
import { TestRoutesController, counters } from "./helpers/test-routes.ts";

describe("idempotency", () => {
  let db: Db;
  let api: TestApp;
  let a: TenantFixture;
  let b: TenantFixture;
  let n = 0;
  const key = (label: string) => `${label}-${Date.now()}-${n++}`;
  const owner = () => a.users.OWNER?.token;

  const post = (path: string, body: object, idemKey?: string, token = owner()) => {
    const r = api.http.post(path).set("Authorization", `Bearer ${token}`);
    if (idemKey) r.set("Idempotency-Key", idemKey);
    return r.send(body);
  };
  const count = (tenant: TenantFixture, name: string) =>
    withTenant(db.owner, tenant.id, async (c) => Number((await c.query("select count(*) as n from customers where name = $1", [name])).rows[0]?.n));
  const keyRows = (tenant: TenantFixture, k: string) =>
    withTenant(db.owner, tenant.id, async (c) => (await c.query("select status, response_status from idempotency_keys where key = $1", [k])).rows as Array<{ status: string; response_status: number | null }>);

  before(async () => {
    db = await connectDb();
    api = await startApp(db, { extraControllers: [TestRoutesController] });
    a = await createTenant(db, "idem-a");
    b = await createTenant(db, "idem-b");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("requires a well-formed Idempotency-Key", async () => {
    const missing = await post("/v1/test/idem", { name: "m" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
    for (const bad of ["short", "has space here", "x".repeat(129), "semi;colon;key"]) {
      const res = await post("/v1/test/idem", { name: "m" }, bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(await count(a, "m"), 0);
  });

  it("same key and same request: stored response replayed, nothing created twice", async () => {
    const k = key("replay");
    const before = counters.idem;
    const first = await post("/v1/test/idem", { name: "replay-cust" }, k);
    const second = await post("/v1/test/idem", { name: "replay-cust" }, k);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.deepEqual(second.body, first.body);
    assert.equal(first.headers["idempotent-replayed"], undefined);
    assert.equal(second.headers["idempotent-replayed"], "true");
    assert.equal(counters.idem - before, 1, "handler ran once");
    assert.equal(await count(a, "replay-cust"), 1);
    assert.deepEqual(await keyRows(a, k), [{ status: "completed", response_status: 201 }]);
  });

  it("same key with a different body is a conflict and runs nothing", async () => {
    const k = key("diff");
    assert.equal((await post("/v1/test/idem", { name: "diff-1" }, k)).status, 201);
    const res = await post("/v1/test/idem", { name: "diff-2" }, k);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(res.body.error.details.reason, "different_request");
    assert.equal(await count(a, "diff-2"), 0);
  });

  it("key order in the body does not matter; the query string does", async () => {
    const k = key("canon");
    const r1 = await api.http.post("/v1/test/idem").set("Authorization", `Bearer ${owner()}`).set("Idempotency-Key", k).set("Content-Type", "application/json").send('{"name":"canon","delayMs":0}');
    const r2 = await api.http.post("/v1/test/idem").set("Authorization", `Bearer ${owner()}`).set("Idempotency-Key", k).set("Content-Type", "application/json").send('{"delayMs":0,"name":"canon"}');
    assert.equal(r2.headers["idempotent-replayed"], "true");
    assert.deepEqual(r2.body, r1.body);
    const r3 = await api.http.post("/v1/test/idem?x=1").set("Authorization", `Bearer ${owner()}`).set("Idempotency-Key", k).send({ name: "canon", delayMs: 0 });
    assert.equal(r3.status, 409);
  });

  it("concurrent duplicates: one execution, everyone gets the same answer", async () => {
    const k = key("race");
    const before = counters.idem;
    const results = await Promise.all(Array.from({ length: 6 }, () => post("/v1/test/idem", { name: "race-cust", delayMs: 400 }, k)));
    assert.equal(counters.idem - before, 1);
    assert.equal(await count(a, "race-cust"), 1);
    for (const r of results) {
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body, results[0]?.body);
    }
    assert.equal(results.filter((r) => r.headers["idempotent-replayed"] === "true").length, 5);
  });

  it("a duplicate that cannot wait long enough gets 409 IDEMPOTENCY_CONFLICT (in_progress)", async () => {
    const impatient = await startApp(db, { config: devConfig(db, { IDEMPOTENCY_WAIT_MS: "0" }), extraControllers: [TestRoutesController] });
    try {
      const k = key("busy");
      const call = (delayMs: number) =>
        impatient.http.post("/v1/test/idem").set("Authorization", `Bearer ${owner()}`).set("Idempotency-Key", k).send({ name: "busy-cust", delayMs });
      const first = call(500).then((r) => r);
      await new Promise((r) => setTimeout(r, 150));
      const dup = await call(500);
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "IDEMPOTENCY_CONFLICT");
      assert.equal(dup.body.error.details.reason, "in_progress");
      assert.equal(dup.headers["retry-after"], "1");
      assert.equal((await first).status, 201);
      assert.equal(await count(a, "busy-cust"), 1);
    } finally {
      await impatient.close();
    }
  });

  it("keys are scoped per tenant and per route", async () => {
    const k = key("scope");
    assert.equal((await post("/v1/test/idem", { name: "scope-a" }, k)).status, 201);
    const other = await post("/v1/test/idem", { name: "scope-a" }, k, b.users.OWNER?.token);
    assert.equal(other.status, 201);
    assert.equal(other.headers["idempotent-replayed"], undefined, "tenant B's call is its own");
    assert.equal(await count(b, "scope-a"), 1);
    const route = await post("/v1/test/idem/other", { name: "scope-route" }, k);
    assert.equal(route.status, 201);
    assert.equal(route.headers["idempotent-replayed"], undefined);
  });

  it("a business error rolls back the work, is stored, and is replayed", async () => {
    const k = key("slot");
    const before = counters.idem;
    const first = await post("/v1/test/idem/fail", { mode: "slot" }, k);
    const second = await post("/v1/test/idem/fail", { mode: "slot" }, k);
    assert.equal(first.status, 409);
    assert.equal(first.body.error.code, "BOOKING_SLOT_TAKEN");
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.headers["idempotent-replayed"], "true");
    assert.equal(counters.idem - before, 1);
    assert.equal(await count(a, "fail-slot"), 0, "the row written before the error was rolled back");
  });

  it("validation errors and server errors are not stored: the key is released and a retry runs again", async () => {
    const kv = key("val");
    await post("/v1/test/idem/fail", { mode: "validation" }, kv);
    assert.deepEqual(await keyRows(a, kv), []);
    const ki = key("int");
    const r = await post("/v1/test/idem/fail", { mode: "internal" }, ki);
    assert.equal(r.status, 500);
    assert.deepEqual(await keyRows(a, ki), []);
    const kf = key("flaky");
    counters.flaky = 0;
    assert.equal((await post("/v1/test/idem/fail", { mode: "flaky" }, kf)).status, 500);
    const retry = await post("/v1/test/idem/fail", { mode: "flaky" }, kf);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.ok, true);
  });

  it("an expired key is treated as new; a stale in-progress key from a dead request is taken over", async () => {
    const k = key("exp");
    assert.equal((await post("/v1/test/idem", { name: "exp-cust" }, k)).status, 201);
    await withTenant(db.owner, a.id, (c) => c.query("update idempotency_keys set expires_at = now() - interval '1 minute' where key = $1", [k]));
    const again = await post("/v1/test/idem", { name: "exp-cust" }, k);
    assert.equal(again.status, 201);
    assert.equal(again.headers["idempotent-replayed"], undefined);
    assert.equal(await count(a, "exp-cust"), 2);

    const ks = key("stale");
    const hash = requestHash({ method: "POST", route: "POST /v1/test/idem", query: {}, body: { name: "stale-cust" } });
    await withTenant(db.owner, a.id, (c) =>
      c.query("insert into idempotency_keys (tenant_id, key, route, request_hash, locked_at) values ($1,$2,'POST /v1/test/idem',$3, now() - interval '10 minutes')", [a.id, ks, hash]),
    );
    const taken = await post("/v1/test/idem", { name: "stale-cust" }, ks);
    assert.equal(taken.status, 201);
    assert.equal(await count(a, "stale-cust"), 1);
  });

  it("the stored response lives for 24 hours", async () => {
    const k = key("ttl");
    await post("/v1/test/idem", { name: "ttl-cust" }, k);
    const hours = await withTenant(db.owner, a.id, async (c) =>
      Number((await c.query("select extract(epoch from (expires_at - now())) / 3600 as h from idempotency_keys where key = $1", [k])).rows[0]?.h),
    );
    assert.ok(hours > 23.9 && hours <= 24.01, String(hours));
  });
});
