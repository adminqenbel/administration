import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withTenant } from "@qenbel/db";
import { type Db, type TenantFixture, type TestApp, addPlatformAdmin, auditRows, connectDb, createTenant, devConfig, startApp } from "./helpers/harness.ts";

const ADMIN = "dev|plat-admin";
const body = (slug: string, over: Record<string, unknown> = {}) => ({
  name: "Glow Salon",
  slug,
  packId: "salon",
  owner: { name: "Asha Owner", email: `${slug}@example.test`, externalSubject: `dev|${slug}-owner` },
  ...over,
});

describe("platform tenant creation and onboarding", () => {
  let db: Db;
  let api: TestApp;
  let existing: TenantFixture;

  before(async () => {
    db = await connectDb();
    api = await startApp(db);
    await addPlatformAdmin(db, ADMIN);
    existing = await createTenant(db, "existing");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("a platform admin creates a business with its pack and OWNER; the owner can then sign in", async () => {
    const slug = `glow-${randomUUID().slice(0, 8)}`;
    const res = await api.post("/v1/platform/tenants", ADMIN, body(slug));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { tenant, owner } = res.body;
    assert.equal(tenant.slug, slug);
    assert.equal(tenant.packId, "salon");
    assert.match(tenant.packVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(tenant.deploymentMode, "central");
    assert.equal(tenant.status, "active");
    assert.equal(owner.role, "OWNER");

    const me = await api.get("/v1/me", `dev|${slug}-owner`);
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant.id, tenant.id);
    assert.equal(me.body.principal.role, "OWNER");
    assert.equal(me.body.pack.id, "salon");
    assert.equal(me.body.pack.terminology.booking, "Appointment");
    assert.equal(me.body.deploymentMode, "central");

    const profile = await api.get("/v1/business/profile", `dev|${slug}-owner`);
    assert.equal(profile.body.profile.name, "Glow Salon");
    const put = await api.put("/v1/business/profile", `dev|${slug}-owner`, { name: "Glow Studio", defaultTimezone: "Asia/Kolkata" });
    assert.equal(put.status, 200);
    assert.equal(put.body.profile.name, "Glow Studio");
  });

  it("picks the pack from the registry: a restaurant gets restaurant words", async () => {
    const slug = `rest-${randomUUID().slice(0, 8)}`;
    const res = await api.post("/v1/platform/tenants", ADMIN, body(slug, { packId: "restaurant", timezone: "Asia/Kolkata" }));
    assert.equal(res.status, 201);
    const me = await api.get("/v1/me", `dev|${slug}-owner`);
    assert.equal(me.body.pack.id, "restaurant");
    assert.notEqual(me.body.pack.terminology.booking, "Appointment");
  });

  it("writes an audit row for the creation, attributed to the platform admin", async () => {
    const slug = `aud-${randomUUID().slice(0, 8)}`;
    const res = await api.post("/v1/platform/tenants", ADMIN, body(slug));
    const rows = await auditRows(db, res.body.tenant.id, "platform.tenant.create");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.actor_kind, "platform_admin");
    assert.equal(rows[0]?.actor_id, ADMIN);
    assert.equal(rows[0]?.outcome, "success");
    assert.equal(rows[0]?.entity_id, res.body.tenant.id);
  });

  it("is for PLATFORM_ADMIN only: tenant users and anonymous callers are refused", async () => {
    const slug = `nope-${randomUUID().slice(0, 8)}`;
    assert.equal((await api.post("/v1/platform/tenants", undefined, body(slug))).status, 401);
    for (const role of ["OWNER", "MANAGER", "STAFF"]) {
      assert.equal((await api.post("/v1/platform/tenants", existing.users[role]?.token, body(slug))).status, 403, role);
    }
    const count = await db.owner.query("select count(*)::int as n from platform_admins");
    assert.ok(count.rows[0].n >= 1);
    const check = await db.app.query("select count(*)::int as n from auth_lookup_user('dev', $1)", [`dev|${slug}-owner`]);
    assert.equal(check.rows[0].n, 0, "nothing was created");
  });

  it("rejects unknown packs, bad slugs, extra keys and a smuggled role or tenant id", async () => {
    const slug = `bad-${randomUUID().slice(0, 8)}`;
    const cases: Array<Record<string, unknown>> = [
      body(slug, { packId: "mining" }),
      body("Bad Slug!"),
      body(slug, { extra: 1 }),
      body(slug, { owner: { name: "O", externalSubject: `dev|${slug}`, role: "PLATFORM_ADMIN" } }),
      body(slug, { owner: { name: "O", externalSubject: "user_clerkid" } }),
      body(slug, { timezone: "Not/AZone" }),
      body(slug, { id: randomUUID() }),
      { ...body(slug), tenantId: randomUUID() },
    ];
    for (const c of cases) {
      const res = await api.post("/v1/platform/tenants", ADMIN, c);
      assert.equal(res.status, 400, JSON.stringify(c));
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
    }
    const none = await db.app.query("select count(*)::int as n from auth_lookup_user('dev', $1)", [`dev|${slug}`]);
    assert.equal(none.rows[0].n, 0);
  });

  it("a repeated slug is a 409 and leaves no partial business behind", async () => {
    const slug = `dup-${randomUUID().slice(0, 8)}`;
    assert.equal((await api.post("/v1/platform/tenants", ADMIN, body(slug))).status, 201);
    const again = await api.post("/v1/platform/tenants", ADMIN, body(slug, { owner: { name: "Other", externalSubject: `dev|${slug}-second` } }));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");
    assert.equal(again.body.error.details.field, "slug");
    const second = await db.app.query("select count(*)::int as n from auth_lookup_user('dev', $1)", [`dev|${slug}-second`]);
    assert.equal(second.rows[0].n, 0);
  });
});

describe("isolated deployment mode", () => {
  let db: Db;
  let api: TestApp;
  const tenantId = randomUUID();

  before(async () => {
    db = await connectDb();
    api = await startApp(db, { config: devConfig(db, { DEPLOYMENT_MODE: "isolated", ISOLATED_TENANT_ID: tenantId }) });
    await addPlatformAdmin(db, ADMIN);
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("creates exactly one tenant, whose id comes from configuration; a second is refused", async () => {
    const res = await api.post("/v1/platform/tenants", ADMIN, body("only-one"));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.tenant.id, tenantId);
    assert.equal(res.body.tenant.deploymentMode, "isolated");
    const again = await api.post("/v1/platform/tenants", ADMIN, body("second-one"));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");
  });

  it("serves only that tenant: its own users work, users and keys of other tenants are refused", async () => {
    const me = await api.get("/v1/me", "dev|only-one-owner");
    assert.equal(me.status, 200);
    assert.equal(me.body.tenant.id, tenantId);
    assert.equal(me.body.deploymentMode, "isolated");

    const stranger = await createTenant(db, "stranger"); // a central tenant that happens to share this database
    assert.equal((await api.get("/v1/me", stranger.users.OWNER?.token)).status, 403);
    assert.equal((await api.get("/v1/business/profile", stranger.users.OWNER?.token)).status, 403);

    const central = await startApp(db);
    try {
      const key = await central.post("/v1/integrations/api-credentials", stranger.users.OWNER?.token, { name: "k", toolScopes: ["get_catalogue"] });
      assert.equal(key.status, 201);
      assert.equal((await api.get("/v1/me", key.body.key)).status, 401);
      assert.equal((await central.get("/v1/me", key.body.key)).status, 200);
    } finally {
      await central.close();
    }
    const rows = await withTenant(db.owner, tenantId, async (c) => (await c.query("select deployment_mode from tenants")).rows);
    assert.deepEqual(rows, [{ deployment_mode: "isolated" }]);
  });
});
