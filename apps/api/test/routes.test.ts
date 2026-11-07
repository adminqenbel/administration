// Route-permission enumeration. A route with no declared access policy is a bug, and this file fails on it.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Controller, Get } from "@nestjs/common";
import { ToolName, UserRole } from "@qenbel/shared";
import { listTools } from "@qenbel/tool-registry";
import { GLOBAL_PREFIX, UNPREFIXED_ROUTES } from "../src/bootstrap.ts";
import { Permission } from "../src/authz/decorators.ts";
import { ALL_API_PERMISSIONS, API_ROLE_PERMISSIONS, ApiPermission, isApiPermission, permissionsForCredential } from "../src/authz/permissions.ts";
import { listRoutes, type RouteInfo } from "../src/authz/route-inventory.ts";
import {
  type Db, type TenantFixture, type TestApp, addPlatformAdmin, auditRows, connectDb, createTenant, startApp,
} from "./helpers/harness.ts";
import { TestRoutesController } from "./helpers/test-routes.ts";

const UUID = "00000000-0000-4000-8000-0000000000aa";
const fill = (path: string) => path.replace(/:[A-Za-z]+/g, (m) => (m.toLowerCase().includes("ms") ? "1" : UUID));

describe("route permissions", () => {
  let db: Db;
  let api: TestApp;
  let probe: TestApp;
  let t: TenantFixture;
  let routes: RouteInfo[];

  before(async () => {
    db = await connectDb();
    api = await startApp(db);
    probe = await startApp(db, { extraControllers: [TestRoutesController] });
    t = await createTenant(db, "routes");
    await addPlatformAdmin(db, "dev|routes-admin");
    routes = listRoutes(api.app, GLOBAL_PREFIX, UNPREFIXED_ROUTES);
  });
  after(async () => {
    await api.close();
    await probe.close();
    await db.close();
  });

  it("the application has routes, and every one declares @Permission, @Authenticated, @PlatformAdmin or @Public", () => {
    assert.ok(routes.length >= 8, `only ${routes.length} routes found`);
    const undeclared = routes.filter((r) => r.policy === undefined).map((r) => `${r.method} ${r.path} (${r.controller}.${r.handler})`);
    assert.deepEqual(undeclared, [], `routes without a declared access policy:\n${undeclared.join("\n")}`);
    for (const r of routes) {
      if (r.policy?.kind === "permission") assert.ok(isApiPermission(r.policy.permission), `${r.path}: unknown permission ${r.policy.permission}`);
    }
  });

  it("lists the expected routes (a new route shows up here on purpose)", () => {
    const actual = routes.map((r) => `${r.method} ${r.path} ${r.policy?.kind === "permission" ? r.policy.permission : r.policy?.kind}`);
    assert.deepEqual(actual.sort(), [
      "GET /health public",
      "GET /health/db public",
      "GET /v1/business/profile business:read",
      "PUT /v1/business/profile business:write",
      "GET /v1/integrations/api-credentials integrations:read",
      "POST /v1/integrations/api-credentials integrations:manage",
      "POST /v1/integrations/api-credentials/:credentialId/revoke integrations:manage",
      "GET /v1/me authenticated",
      "POST /v1/platform/tenants platform_admin",
    ].sort());
  });

  it("only /v1/me is open to API credentials", () => {
    assert.deepEqual(routes.filter((r) => r.allowsApiCredential).map((r) => r.path), ["/v1/me"]);
  });

  it("over HTTP: every non-public route answers 401 with no credentials and with a bad one", async () => {
    for (const r of routes) {
      if (r.policy?.kind === "public") continue;
      const path = fill(r.path);
      const send = (token?: string) => {
        const req = api.http[r.method.toLowerCase() as "get" | "post" | "put"](path);
        if (token) req.set("Authorization", `Bearer ${token}`);
        return r.method === "GET" ? req : req.send({});
      };
      for (const token of [undefined, "dev|nobody-here", "garbage", "qbk_AAAAAAAAAAAA." + "x".repeat(43)]) {
        const res = await send(token);
        assert.ok(res.status === 401 || res.status === 403, `${r.method} ${r.path} with ${token ?? "no token"} gave ${res.status}`);
        if (token === undefined || token === "garbage") assert.equal(res.status, 401, `${r.method} ${r.path}`);
        assert.equal(res.body.error.code, res.status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN");
      }
    }
  });

  it("a route with no declared policy is refused even for an OWNER, and logged", async () => {
    const found = listRoutes(probe.app, GLOBAL_PREFIX, UNPREFIXED_ROUTES).filter((r) => r.policy === undefined);
    assert.deepEqual(found.map((r) => r.path), ["/v1/test/no-policy"], "the enumeration sees the undeclared route");
    for (const token of [t.users.OWNER?.token, undefined]) {
      const res = await probe.get("/v1/test/no-policy", token);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.ok(!JSON.stringify(res.body).includes("reached"));
    }
    assert.ok(probe.logs.lines.some((l) => l.includes("no declared access policy")));
  });

  it("an unknown permission string fails when the route is declared, not when it is called", () => {
    assert.throws(() => {
      @Controller("typo")
      class Typo {
        @Permission("bookings:reed" as never)
        @Get()
        x() {}
      }
      return Typo;
    }, /Unknown permission/);
  });

  it("role matrix over HTTP: STAFF can read the profile but not change it; denial is audited", async () => {
    const staff = t.users.STAFF?.token;
    const manager = t.users.MANAGER?.token;
    const owner = t.users.OWNER?.token;
    assert.equal((await api.get("/v1/business/profile", staff)).status, 200);
    const denied = await api.put("/v1/business/profile", staff, { name: "Renamed by staff" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "FORBIDDEN");
    assert.equal((await api.put("/v1/business/profile", manager, { name: "Renamed by manager" })).status, 403, "MANAGER has no business:write in @qenbel/shared");
    assert.equal((await api.put("/v1/business/profile", owner, { name: "Renamed by owner" })).status, 200);
    assert.equal((await api.get("/v1/integrations/api-credentials", staff)).status, 403);
    assert.equal((await api.get("/v1/integrations/api-credentials", manager)).status, 200);
    assert.equal((await api.post("/v1/integrations/api-credentials", manager, { name: "k", toolScopes: ["get_catalogue"] })).status, 403);

    const rows = await auditRows(db, t.id, "authz.denied");
    assert.ok(rows.length >= 3);
    const first = rows[0] as { outcome: string; actor_kind: string; details: { required: string; route: string } };
    assert.equal(first.outcome, "denied");
    assert.equal(first.actor_kind, "user");
    assert.equal(first.details.required, "business:write");
    assert.equal(first.details.route, "/v1/business/profile");
  });

  it("platform routes: a tenant OWNER is refused, a platform admin is let in", async () => {
    const body = { name: "X", slug: "x-should-not-exist", packId: "salon", owner: { name: "O", externalSubject: "dev|x-owner" } };
    const denied = await api.post("/v1/platform/tenants", t.users.OWNER?.token, body);
    assert.equal(denied.status, 403);
    const row = (await auditRows(db, t.id, "authz.denied")).find((r) => (r.details as { required?: string }).required === "platform_admin");
    assert.ok(row, "denied platform access is audited in the caller's tenant");
    const admin = await api.post("/v1/platform/tenants", "dev|routes-admin", { ...body, slug: `routes-${Date.now()}` });
    assert.equal(admin.status, 201, JSON.stringify(admin.body));
  });

  it("a platform admin who belongs to no tenant is refused on every tenant route", async () => {
    for (const r of routes) {
      if (r.policy?.kind !== "permission") continue;
      const req = api.http[r.method.toLowerCase() as "get" | "post" | "put"](fill(r.path)).set("Authorization", "Bearer dev|routes-admin");
      const res = await (r.method === "GET" ? req : req.send({}));
      assert.equal(res.status, 403, `${r.method} ${r.path}`);
    }
  });
});

describe("permission list is reconciled", () => {
  it("every tool's requiredPermission is a known API permission", () => {
    for (const tool of listTools()) assert.ok(isApiPermission(tool.requiredPermission), `${tool.name} requires unknown permission ${tool.requiredPermission}`);
  });

  it("every role permission is known, OWNER has all, STAFF is the narrowest", () => {
    for (const perms of Object.values(API_ROLE_PERMISSIONS)) for (const p of perms) assert.ok(isApiPermission(p));
    assert.deepEqual([...(API_ROLE_PERMISSIONS[UserRole.OWNER] ?? [])].sort(), [...ALL_API_PERMISSIONS].sort());
    const staff = new Set<string>(API_ROLE_PERMISSIONS[UserRole.STAFF]);
    const manager = new Set<string>(API_ROLE_PERMISSIONS[UserRole.MANAGER]);
    for (const p of staff) assert.ok(manager.has(p), `${p} is given to STAFF but not MANAGER`);
    for (const forbidden of [ApiPermission.BUSINESS_WRITE, ApiPermission.INTEGRATIONS_MANAGE, ApiPermission.USERS_MANAGE, ApiPermission.AUDIT_READ, ApiPermission.PAYMENTS_WRITE]) {
      assert.ok(!staff.has(forbidden), `STAFF must not have ${forbidden}`);
    }
    assert.ok(!manager.has(ApiPermission.INTEGRATIONS_MANAGE) && !manager.has(ApiPermission.USERS_MANAGE) && !manager.has(ApiPermission.BUSINESS_PACK));
  });

  it("a credential's permissions are exactly what its tools require", () => {
    assert.deepEqual([...permissionsForCredential([ToolName.GET_CATALOGUE])], ["catalogue:read"]);
    assert.deepEqual([...permissionsForCredential([ToolName.CREATE_BOOKING_HOLD, ToolName.CONFIRM_BOOKING])], ["bookings:write"]);
    assert.deepEqual([...permissionsForCredential(["not_a_tool", "execute_sql"])], []);
    assert.deepEqual([...permissionsForCredential([])], []);
  });
});
