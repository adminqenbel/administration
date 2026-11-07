// Authentication over HTTP: Clerk session tokens, the dev provider, and API credentials.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from "jose";
import { withTenant } from "@qenbel/db";
import { loadConfig } from "../src/config/config.ts";
import {
  type Db, type TenantFixture, type TestApp, TEST_PEPPER, addPlatformAdmin, addUser, auditRows, setTenantStatus, connectDb, createTenant, devConfig, devEnv, startApp,
} from "./helpers/harness.ts";

const ISSUER = "https://clerk.example.test";
const ORIGIN = "https://app.example.test";

describe("clerk sessions over HTTP", () => {
  let db: Db;
  let api: TestApp;
  let t: TenantFixture;
  let suspended: TenantFixture;
  let priv: CryptoKey;
  let otherPriv: CryptoKey;

  const token = async (sub: string, over: { iss?: string; azp?: string; exp?: number; key?: CryptoKey } = {}) =>
    new SignJWT({ azp: over.azp ?? ORIGIN })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(sub)
      .setIssuer(over.iss ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime(over.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign(over.key ?? priv);

  before(async () => {
    db = await connectDb();
    const pair = await generateKeyPair("RS256", { extractable: true });
    priv = pair.privateKey;
    otherPriv = (await generateKeyPair("RS256", { extractable: true })).privateKey;
    const config = loadConfig(
      devEnv(db, {
        NODE_ENV: "test",
        AUTH_PROVIDER: "clerk",
        CLERK_JWT_KEY: await exportSPKI(pair.publicKey),
        CLERK_ISSUER: ISSUER,
        CLERK_AUTHORIZED_PARTIES: ORIGIN,
      }),
    );
    api = await startApp(db, { config });
    t = await createTenant(db, "clerk", { roles: [] });
    await addUser(db, t.id, "OWNER", "clerk-owner", { provider: "clerk", subject: "user_owner1" });
    await addUser(db, t.id, "STAFF", "clerk-gone", { provider: "clerk", subject: "user_gone1", disabled: true });
    suspended = await createTenant(db, "suspended", { roles: [] });
    await addUser(db, suspended.id, "OWNER", "susp-owner", { provider: "clerk", subject: "user_susp1" });
    await setTenantStatus(db, suspended.id, "suspended");
    await addPlatformAdmin(db, "user_admin1", "clerk");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("a valid Clerk token signs the user in; tenant and role come from the database", async () => {
    const res = await api.get("/v1/me", await token("user_owner1"));
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.id, t.id);
    assert.equal(res.body.principal.role, "OWNER");
    assert.equal(res.body.principal.kind, "user");
    assert.ok(res.body.principal.permissions.includes("business:write"));
  });

  it("missing, malformed, forged, expired, wrong-issuer and wrong-azp tokens all get the same 401", async () => {
    const attempts: Array<[string, string | undefined]> = [
      ["missing", undefined],
      ["not bearer", "Basic dXNlcjpwYXNz"],
      ["garbage", "garbage"],
      ["forged", await token("user_owner1", { key: otherPriv })],
      ["expired", await token("user_owner1", { exp: Math.floor(Date.now() / 1000) - 120 })],
      ["wrong issuer", await token("user_owner1", { iss: "https://evil.example.test" })],
      ["wrong azp", await token("user_owner1", { azp: "https://evil.example.test" })],
      ["dev token in clerk mode", "dev|clerk-owner"],
    ];
    const bodies = new Set<string>();
    for (const [label, tok] of attempts) {
      const req = api.http.get("/v1/me");
      if (label === "not bearer") req.set("Authorization", tok as string);
      else if (tok) req.set("Authorization", `Bearer ${tok}`);
      const res = await req;
      assert.equal(res.status, 401, label);
      assert.equal(res.body.error.code, "UNAUTHENTICATED", label);
      bodies.add(JSON.stringify(res.body));
    }
    assert.equal(bodies.size, 1, "every cause produces the same body, so the response reveals nothing about why");
  });

  it("unknown user, deactivated user and suspended tenant are refused identically", async () => {
    const unknown = await api.get("/v1/me", await token("user_neverseen"));
    const deactivated = await api.get("/v1/me", await token("user_gone1"));
    const inSuspended = await api.get("/v1/me", await token("user_susp1"));
    for (const r of [unknown, deactivated, inSuspended]) {
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "FORBIDDEN");
    }
    assert.deepEqual(unknown.body, deactivated.body);
    assert.deepEqual(unknown.body, inSuspended.body);
  });

  it("an email, tenant or role in the token is never used: only the Clerk user id counts", async () => {
    const forged = await new SignJWT({ azp: ORIGIN, tenant_id: suspended.id, tenantId: suspended.id, role: "OWNER", email: "owner@example.test" })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("user_neverseen")
      .setIssuer(ISSUER)
      .setExpirationTime("5m")
      .sign(priv);
    assert.equal((await api.get("/v1/me", forged)).status, 403);
  });

  it("a platform admin with no tenant gets a principal with no tenant", async () => {
    const res = await api.get("/v1/me", await token("user_admin1"));
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant, null);
    assert.equal(res.body.principal.kind, "platform_admin");
    assert.equal(res.body.principal.isPlatformAdmin, true);
    assert.deepEqual(res.body.principal.permissions, []);
  });

  it("the dev provider is not available in this configuration", () => {
    assert.throws(() => devConfig(db, { NODE_ENV: "test" }), /NODE_ENV=development/);
  });
});

describe("dev provider over HTTP (development, loopback)", () => {
  let db: Db;
  let api: TestApp;
  let t: TenantFixture;

  before(async () => {
    db = await connectDb();
    api = await startApp(db);
    t = await createTenant(db, "dev");
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("dev|<subject> signs in an existing user; an unknown subject is refused; a non-dev token is refused", async () => {
    assert.equal((await api.get("/v1/me", t.users.OWNER?.token)).status, 200);
    assert.equal((await api.get("/v1/me", "dev|someone-else")).status, 403);
    assert.equal((await api.get("/v1/me", "salon-owner")).status, 401);
  });

  it("the identity is never taken from a header", async () => {
    const res = await api.http.get("/v1/me").set("X-User-Id", t.users.OWNER?.id ?? "").set("X-Forwarded-User", t.users.OWNER?.subject ?? "").set("Cf-Access-Authenticated-User-Email", "owner@example.test");
    assert.equal(res.status, 401);
  });
});

describe("API credentials over HTTP", () => {
  let db: Db;
  let api: TestApp;
  let a: TenantFixture;
  let b: TenantFixture;
  let keyA = "";
  let keyB = "";
  let credA = "";

  const create = async (tenant: TenantFixture, body: object = { name: "Integration", toolScopes: ["get_catalogue", "check_availability"] }) => {
    const res = await api.post("/v1/integrations/api-credentials", tenant.users.OWNER?.token, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res;
  };

  before(async () => {
    db = await connectDb();
    api = await startApp(db);
    a = await createTenant(db, "cred-a");
    b = await createTenant(db, "cred-b");
    const ra = await create(a);
    const rb = await create(b);
    keyA = ra.body.key;
    keyB = rb.body.key;
    credA = ra.body.credential.id;
  });
  after(async () => {
    await api.close();
    await db.close();
  });

  it("the key is shown once, in the creation response only", async () => {
    assert.match(keyA, /^qbk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
    assert.equal((await api.post("/v1/integrations/api-credentials", a.users.OWNER?.token, { name: "x", toolScopes: ["get_catalogue"] })).headers["cache-control"], "no-store");
    const list = await api.get("/v1/integrations/api-credentials", a.users.MANAGER?.token);
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(keyA.split(".")[1] as string), "the secret is not in the list");
    assert.ok(list.body.data.every((c: Record<string, unknown>) => !("key" in c) && !("secretHash" in c) && !("secret_hash" in c)));
  });

  it("only a peppered hash is stored; the secret is in no table, audit row or log", async () => {
    const secret = keyA.split(".")[1] as string;
    const row = await withTenant(db.owner, a.id, async (c) => (await c.query("select secret_hash, pepper_version from api_credentials where id = $1", [credA])).rows[0] as { secret_hash: string; pepper_version: number });
    assert.match(row.secret_hash, /^[0-9a-f]{64}$/);
    assert.ok(!row.secret_hash.includes(secret));
    assert.equal(row.pepper_version, 1);
    const audit = JSON.stringify(await auditRows(db, a.id));
    assert.ok(!audit.includes(secret));
    assert.ok(audit.includes("integrations.api_credential.create"));
    assert.ok(!api.logs.lines.join("\n").includes(secret));
  });

  it("a credential signs in as its own tenant with permissions from its tools only", async () => {
    const res = await api.get("/v1/me", keyA);
    assert.equal(res.status, 200);
    assert.equal(res.body.principal.kind, "api_credential");
    assert.equal(res.body.principal.channel, "api");
    assert.equal(res.body.principal.role, null);
    assert.equal(res.body.tenant.id, a.id);
    assert.deepEqual([...res.body.principal.permissions].sort(), ["bookings:read", "catalogue:read"]);
    assert.deepEqual([...res.body.principal.allowedTools].sort(), ["check_availability", "get_catalogue"]);
  });

  it("cross-tenant: each key sees only its own tenant, and A's key cannot be used with B's data", async () => {
    assert.equal((await api.get("/v1/me", keyB)).body.tenant.id, b.id);
    // Tenant hints in headers, query or body change nothing and are never read.
    const hinted = await api.http.get("/v1/me").set("Authorization", `Bearer ${keyA}`).set("X-Tenant-Id", b.id);
    assert.equal(hinted.body.tenant.id, a.id);
    assert.equal((await api.http.get(`/v1/me?tenantId=${b.id}`).set("Authorization", `Bearer ${keyA}`)).status, 400);
    // A's lookup id with B's secret (and the reverse) does not authenticate.
    const [lookupA] = keyA.split(".");
    const [, secretB] = keyB.split(".");
    assert.equal((await api.get("/v1/me", `${lookupA}.${secretB}`)).status, 401);
  });

  it("a credential cannot use routes that do not opt in to credentials, even with a matching permission", async () => {
    const res = await api.get("/v1/business/profile", keyA);
    assert.equal(res.status, 403);
    assert.equal((await api.get("/v1/integrations/api-credentials", keyA)).status, 403);
    assert.equal((await api.post("/v1/platform/tenants", keyA, {})).status, 403);
    const rows = await auditRows(db, a.id, "authz.denied");
    assert.ok(rows.some((r) => r.actor_kind === "api_credential"));
  });

  it("wrong secret, malformed, unknown and widget keys are all the same 401", async () => {
    const [lookup, secret] = keyA.split(".") as [string, string];
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    const bodies = new Set<string>();
    for (const bad of [`${lookup}.${flipped}`, `${lookup}.short`, "qbk_nonexistent00.".padEnd(60, "x"), "qbk_", `qbk_AAAAAAAAAAAA.${"x".repeat(43)}`]) {
      const res = await api.get("/v1/me", bad);
      assert.equal(res.status, 401, bad);
      bodies.add(JSON.stringify(res.body));
    }
    assert.equal(bodies.size, 1);
  });

  it("a widget key is not an API key", async () => {
    await withTenant(db.app, a.id, (c) =>
      c.query("insert into api_credentials (tenant_id, credential_type, name, lookup_id, tool_scopes) values ($1,'widget_key','w','qbk_widgetkey001',array['get_catalogue'])", [a.id]),
    );
    assert.equal((await api.get("/v1/me", `qbk_widgetkey001.${"x".repeat(43)}`)).status, 401);
  });

  it("scopes are limited to what the tenant's pack allows", async () => {
    const res = await api.post("/v1/integrations/api-credentials", a.users.OWNER?.token, { name: "orders", toolScopes: ["create_order_draft"] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_FAILED");
    const bad = await api.post("/v1/integrations/api-credentials", a.users.OWNER?.token, { name: "x", toolScopes: ["execute_sql"] });
    assert.equal(bad.status, 400);
  });

  it("an expired key is refused; a revoked key is refused; revoking is audited", async () => {
    const soon = await create(a, { name: "short", toolScopes: ["get_catalogue"], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal((await api.get("/v1/me", soon.body.key)).status, 200);
    await withTenant(db.owner, a.id, (c) => c.query("update api_credentials set expires_at = now() - interval '1 minute' where id = $1", [soon.body.credential.id]));
    assert.equal((await api.get("/v1/me", soon.body.key)).status, 401);

    const doomed = await create(a);
    assert.equal((await api.get("/v1/me", doomed.body.key)).status, 200);
    const revoked = await api.post(`/v1/integrations/api-credentials/${doomed.body.credential.id}/revoke`, a.users.OWNER?.token, {});
    assert.equal(revoked.status, 200);
    assert.ok(revoked.body.credential.revokedAt);
    assert.equal((await api.get("/v1/me", doomed.body.key)).status, 401);
    assert.ok((await auditRows(db, a.id, "integrations.api_credential.revoke")).length >= 1);
  });

  it("a key whose tenant is suspended is refused", async () => {
    const s = await createTenant(db, "cred-susp");
    const k = await create(s);
    assert.equal((await api.get("/v1/me", k.body.key)).status, 200);
    await setTenantStatus(db, s.id, "suspended");
    assert.equal((await api.get("/v1/me", k.body.key)).status, 401);
  });

  it("a key made under another pepper version is refused", async () => {
    const other = await startApp(db, { config: devConfig(db, { API_KEY_PEPPER_VERSION: "2" }) });
    try {
      assert.equal((await other.get("/v1/me", keyA)).status, 401);
    } finally {
      await other.close();
    }
    assert.equal(TEST_PEPPER.length, 64);
  });
});
