// Tenant isolation over HTTP and the per-request unit of work.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "@qenbel/db";
import { type Db, type TenantFixture, type TestApp, addPlatformAdmin, connectDb, createTenant, startApp } from "./helpers/harness.ts";
import { TestRoutesController } from "./helpers/test-routes.ts";

describe("tenant isolation over HTTP", () => {
  let db: Db;
  let api: TestApp;
  let a: TenantFixture;
  let b: TenantFixture;

  const customerCount = (tenantId: string, name: string) =>
    withTenant(db.owner, tenantId, async (c) => Number((await c.query("select count(*) as n from customers where name = $1", [name])).rows[0]?.n));

  before(async () => {
    db = await connectDb();
    api = await startApp(db, { extraControllers: [TestRoutesController] });
    a = await createTenant(db, "iso-a");
    b = await createTenant(db, "iso-b");
    await addPlatformAdmin(db, "dev|iso-admin");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("each user reads and changes only their own business", async () => {
    const before = (await api.get("/v1/business/profile", b.users.OWNER?.token)).body.profile;
    const upd = await api.put("/v1/business/profile", a.users.OWNER?.token, { name: "Alpha Renamed", defaultTimezone: "Asia/Dubai" });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.profile.id, a.id);
    assert.equal(upd.body.profile.name, "Alpha Renamed");
    const after = (await api.get("/v1/business/profile", b.users.OWNER?.token)).body.profile;
    assert.deepEqual(after, before, "tenant B is untouched");
    assert.equal(after.id, b.id);
  });

  it("a tenant id smuggled in body, query, nested body or header is rejected or ignored", async () => {
    const owner = a.users.OWNER?.token;
    for (const body of [{ name: "x", tenantId: b.id }, { name: "x", tenant_id: b.id }, { name: "x", nested: { orgId: b.id } }, { name: "x", role: "OWNER" }, { name: "x", packId: "clinic" }]) {
      const res = await api.put("/v1/business/profile", owner, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
      assert.ok(!JSON.stringify(res.body).includes(b.id), "never echoes the value");
    }
    for (const q of [`tenantId=${b.id}`, `tenant_id=${b.id}`, `a[tenantId]=${b.id}`, `orgId=${b.id}`]) {
      const res = await api.get(`/v1/business/profile?${q}`, owner);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
    }
    const viaHeader = await api.http.get("/v1/business/profile").set("Authorization", `Bearer ${owner}`).set("X-Tenant-Id", b.id).set("X-Org-Id", b.id);
    assert.equal(viaHeader.status, 200);
    assert.equal(viaHeader.body.profile.id, a.id);
    const bProfile = (await api.get("/v1/business/profile", b.users.OWNER?.token)).body.profile;
    assert.notEqual(bProfile.name, "x");
  });

  it("a route that takes an id cannot reach another tenant's row: 404, identical to a missing id", async () => {
    const k = await api.post("/v1/integrations/api-credentials", b.users.OWNER?.token, { name: "b-key", toolScopes: ["get_catalogue"] });
    assert.equal(k.status, 201);
    const cross = await api.post(`/v1/integrations/api-credentials/${k.body.credential.id}/revoke`, a.users.OWNER?.token, {});
    const missing = await api.post("/v1/integrations/api-credentials/00000000-0000-4000-8000-000000000999/revoke", a.users.OWNER?.token, {});
    assert.equal(cross.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(cross.body, missing.body);
    assert.equal((await api.get("/v1/me", k.body.key)).status, 200, "B's key still works");
    const list = await api.get("/v1/integrations/api-credentials", a.users.OWNER?.token);
    assert.ok(!JSON.stringify(list.body).includes(k.body.credential.id), "A cannot list B's keys");
    assert.equal((await api.post("/v1/integrations/api-credentials/not-a-uuid/revoke", a.users.OWNER?.token, {})).status, 400);
  });

  it("the transaction setting follows the request, even under parallel load on a shared pool", async () => {
    const jobs = Array.from({ length: 40 }, (_, i) => {
      const t = i % 2 === 0 ? a : b;
      return api.get("/v1/test/tenant-probe", t.users.OWNER?.token).then((res) => ({ res, t }));
    });
    for (const { res, t } of await Promise.all(jobs)) {
      assert.equal(res.status, 200);
      assert.equal(res.body.setting, t.id);
      assert.equal(res.body.ctxTenant, t.id);
      assert.equal(res.body.visibleTenants, 1, "RLS shows exactly the caller's tenant row");
    }
  });

  it("commits on success and rolls back everything on an error", async () => {
    const ok = await api.post("/v1/test/commit", a.users.OWNER?.token, { name: "committed-cust" });
    assert.equal(ok.status, 201);
    assert.equal(await customerCount(a.id, "committed-cust"), 1);
    assert.equal(await customerCount(b.id, "committed-cust"), 0);
    const bad = await api.post("/v1/test/rollback", a.users.OWNER?.token, { name: "rolled-back-cust" });
    assert.equal(bad.status, 409);
    assert.equal(await customerCount(a.id, "rolled-back-cust"), 0);
  });

  it("GET runs read-only: a read route cannot write", async () => {
    const res = await api.get("/v1/test/read-write", a.users.OWNER?.token);
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL");
    assert.equal(await customerCount(a.id, "should-not-exist"), 0);
  });

  it("a platform admin outside any tenant reaches no tenant data", async () => {
    for (const path of ["/v1/business/profile", "/v1/test/tenant-probe", "/v1/integrations/api-credentials"]) {
      assert.equal((await api.get(path, "dev|iso-admin")).status, 403, path);
    }
  });
});
