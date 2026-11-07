import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Db, type TenantFixture, type TestApp, connectDb, createTenant, startApp } from "./helpers/harness.ts";

describe("smoke", () => {
  let db: Db;
  let api: TestApp;
  let t: TenantFixture;

  before(async () => {
    db = await connectDb();
    api = await startApp(db);
    t = await createTenant(db, "smoke");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("GET /health", async () => {
    const res = await api.get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("GET /v1/me as owner", async () => {
    const res = await api.get("/v1/me", t.users.OWNER?.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tenant.id, t.id);
    assert.equal(res.body.principal.role, "OWNER");
  });
});
