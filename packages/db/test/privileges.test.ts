import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { executableFunctions, FUNCTION_ALLOW_LIST, withTenant, type GranteeName } from "../src/index.ts";
import { attempt, baseFixture, bookSlot, connectTestDb, createTenant, type TestDb } from "./helpers.ts";

// SEC-001 / SEC-002 / SEC-003 (docs/security/REVIEW-stage2.md). Privileges are read from the catalog, so a new function that is
// executable by PUBLIC or by a login role without being on FUNCTION_ALLOW_LIST (src/inspect.ts) fails this file.

let db: TestDb;
let A: string;
let B: string;

before(async () => {
  db = await connectTestDb();
  A = await createTenant(db, "priv-a");
  B = await createTenant(db, "priv-b");
});
after(async () => {
  await db.close();
});

describe("function privileges (catalog)", () => {
  for (const grantee of Object.keys(FUNCTION_ALLOW_LIST) as GranteeName[]) {
    it(`${grantee} can execute exactly its allow-listed functions in schema public`, async () => {
      const actual = await executableFunctions(db.owner, grantee);
      assert.deepEqual(actual, [...FUNCTION_ALLOW_LIST[grantee]].sort());
    });
  }

  it("no SECURITY DEFINER function has PUBLIC in its ACL (proacl), and each pins search_path ending in pg_temp", async () => {
    const res = await db.owner.query<{ fn: string; public_exec: boolean; owner: string; cfg: string[] | null }>(
      `select p.oid::regprocedure::text as fn, pg_get_userbyid(p.proowner) as owner, p.proconfig as cfg,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef`);
    assert.ok(res.rows.length >= 12, `expected the definer functions, found ${res.rows.length}`);
    for (const r of res.rows) {
      assert.equal(r.owner, "qenbel_platform", `${r.fn} owner`);
      const sp = (r.cfg ?? []).find((c) => c.startsWith("search_path="));
      assert.ok(sp?.endsWith("pg_temp"), `${r.fn} must pin search_path ending in pg_temp`);
      // current_tenant_id() is the one deliberate exception: the policies of every role call it.
      if (r.fn !== "current_tenant_id()") assert.equal(r.public_exec, false, `${r.fn} is executable by PUBLIC`);
    }
  });

  it("a function created later by the migration role is not PUBLIC-executable (ALTER DEFAULT PRIVILEGES)", async () => {
    const c = await db.owner.connect();
    try {
      await c.query("begin");
      await c.query("create function sec_probe_fn() returns int language sql as 'select 1'");
      const r = await c.query<{ pub: boolean; app: boolean }>(
        `select exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub,
                has_function_privilege('qenbel_app', p.oid, 'EXECUTE') as app
           from pg_proc p where p.proname = 'sec_probe_fn'`);
      assert.deepEqual(r.rows[0], { pub: false, app: false });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});

describe("login roles", () => {
  it("qenbel_auth and qenbel_platform_ops: LOGIN, no superuser, no BYPASSRLS, no role membership either way", async () => {
    const r = await db.owner.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcanlogin: boolean }>(
      "select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcanlogin from pg_roles where rolname in ('qenbel_auth', 'qenbel_platform_ops') order by 1");
    assert.deepEqual(r.rows, [
      { rolname: "qenbel_auth", rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcanlogin: true },
      { rolname: "qenbel_platform_ops", rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcanlogin: true },
    ]);
    const m = await db.owner.query(
      `select 1 from pg_auth_members m
        where m.member in (select oid from pg_roles where rolname in ('qenbel_app', 'qenbel_auth', 'qenbel_platform_ops'))
           or m.roleid in (select oid from pg_roles where rolname in ('qenbel_app', 'qenbel_auth', 'qenbel_platform_ops'))`);
    assert.equal(m.rowCount, 0);
  });

  it("none of the three runtime login roles has any privilege on any table or view", async () => {
    const r = await db.owner.query<{ r: string; t: string }>(
      `select r.rolname as r, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (select rolname from pg_roles where rolname in ('qenbel_auth', 'qenbel_platform_ops')) r
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
          and has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`);
    assert.deepEqual(r.rows, []);
    for (const pool of [db.auth, db.platform]) {
      const t = await attempt(pool, null, "select * from users");
      assert.ok(!t.ok && t.code === "42501", JSON.stringify(t));
    }
  });

  it("qenbel_app cannot SET ROLE to any other QenBel role", async () => {
    for (const role of ["qenbel_platform", "qenbel_migrate", "qenbel_auth", "qenbel_platform_ops"]) {
      const r = await attempt(db.app, null, `set role ${role}`);
      assert.ok(!r.ok && r.code === "42501", `${role}: ${JSON.stringify(r)}`);
    }
  });
});

describe("behaviour: the runtime role cannot reach platform or auth functions (SEC-002)", () => {
  let liveB = "";
  const forbidden: Array<[string, string, unknown[]]> = [
    ["suspend another tenant", "select platform_set_tenant_status($1, 'suspended')", []],
    ["create a tenant", "select platform_create_tenant('sec-x-' || substr(md5(random()::text), 1, 8), 'x')", []],
    ["create a tenant with an owner", "select * from platform_create_tenant_with_owner('sec-y', 'y', 'central', null, null, 'Asia/Kolkata', null, 'dev', 'dev|y', null, 'Y')", []],
    ["list tenants", "select platform_list_active_tenants()", []],
    ["sweep every tenant's holds", "select expire_booking_holds()", []],
    ["purge idempotency rows", "select purge_expired_idempotency_keys()", []],
    ["look up a credential", "select * from auth_lookup_credential('qbk_whatever0000')", []],
    ["look up a user", "select * from auth_lookup_user('dev', 'dev|x')", []],
    ["check platform admin", "select auth_is_platform_admin('dev', 'dev|x')", []],
    ["set the tenant through app_set_tenant", "select app_set_tenant(gen_random_uuid())", []],
    ["install a tenant-proof key", "select platform_set_tenant_proof_keys(decode(repeat('ab', 32), 'hex'))", []],
    ["clear the tenant-proof key", "select platform_clear_tenant_proof_keys()", []],
  ];
  for (const [label, sql] of forbidden) {
    it(`qenbel_app inside a tenant cannot ${label}`, async () => {
      const r = await attempt(db.app, A, sql.replace("$1", `'${B}'`));
      assert.ok(!r.ok && (r.code === "42501" || r.code === "42883"), JSON.stringify(r));
    });
  }

  it("the cross-tenant sweep takes no clock argument any more (a far-future 'now' is not callable by anyone)", async () => {
    for (const pool of [db.app, db.platform]) {
      const r = await attempt(pool, null, "select expire_booking_holds('2999-01-01T00:00:00Z'::timestamptz)");
      assert.ok(!r.ok && r.code === "42883", JSON.stringify(r));
    }
  });

  it("the sweep run by qenbel_platform_ops expires only holds that are really past their expiry", async () => {
    const f = await baseFixture(db, B, { resources: 2 });
    const live = await bookSlot(db, B, { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer, from: 0, to: 30, status: "HOLD", holdExpiresAt: new Date(Date.now() + 600_000) });
    const dead = await bookSlot(db, B, { resourceId: f.resources[1] as string, locationId: f.location, customerId: f.customer, from: 0, to: 30, status: "HOLD", holdExpiresAt: new Date(Date.now() - 60_000) });
    await db.platform.query("select expire_booking_holds()");
    const st = await withTenant(db.app, B, async (c) =>
      Object.fromEntries((await c.query<{ id: string; status: string }>("select id, status from bookings where id = any($1)", [[live, dead]])).rows.map((r) => [r.id, r.status])));
    assert.equal(st[live], "HOLD");
    assert.equal(st[dead], "EXPIRED");
    liveB = live;
  });

  it("the tenant-level sweep stays available to qenbel_app and touches only its own tenant", async () => {
    const f = await baseFixture(db, A, { resources: 1 });
    const holdA = await bookSlot(db, A, { resourceId: f.resources[0] as string, locationId: f.location, customerId: f.customer, from: 100, to: 130, status: "HOLD", holdExpiresAt: new Date(Date.now() + 600_000) });
    const holdB = liveB; // the live hold of tenant B from the previous test
    await withTenant(db.app, A, (c) => c.query("select expire_booking_holds_for_current_tenant('2999-01-01T00:00:00Z')"));
    const a = await withTenant(db.app, A, async (c) => (await c.query<{ status: string }>("select status from bookings where id = $1", [holdA])).rows[0]?.status);
    const b = await withTenant(db.app, B, async (c) => (await c.query<{ status: string }>("select status from bookings where id = $1", [holdB])).rows[0]?.status);
    assert.equal(a, "EXPIRED", "own tenant: the caller may expire its own holds");
    assert.equal(b, "HOLD", "other tenant untouched");
  });

  it("qenbel_auth resolves credentials and users but cannot call platform functions", async () => {
    const ok = await db.auth.query("select * from auth_lookup_user('dev', 'dev|nobody')");
    assert.equal(ok.rowCount, 0);
    const r = await attempt(db.auth, null, "select platform_list_active_tenants()");
    assert.ok(!r.ok && r.code === "42501", JSON.stringify(r));
  });

  it("qenbel_platform_ops cannot call the auth lookups", async () => {
    const r = await attempt(db.platform, null, "select * from auth_lookup_credential('qbk_whatever0000')");
    assert.ok(!r.ok && r.code === "42501", JSON.stringify(r));
  });
});

describe("platform_create_tenant_with_owner", () => {
  it("creates the tenant, its OWNER and the audit row in one transaction", async () => {
    const slug = `ops-${randomUUID().slice(0, 8)}`;
    const subject = `dev|${slug}`;
    const r = await db.platform.query<{ tenant_id: string; owner_user_id: string }>(
      "select * from platform_create_tenant_with_owner($1, 'Ops', 'central', 'salon', '1.0.0', 'Asia/Kolkata', null, 'dev', $2, null, 'Owner', 'admin-1', 'req-1', '127.0.0.1', '{\"k\":1}')",
      [slug, subject]);
    const t = r.rows[0]?.tenant_id as string;
    const seen = await withTenant(db.app, t, async (c) => ({
      users: (await c.query("select role from users")).rows,
      audit: (await c.query("select action, actor_kind, actor_id, request_id from audit_log")).rows,
    }));
    assert.deepEqual(seen.users, [{ role: "OWNER" }]);
    assert.deepEqual(seen.audit, [{ action: "platform.tenant.create", actor_kind: "platform_admin", actor_id: "admin-1", request_id: "req-1" }]);
  });

  it("leaves nothing behind when the owner insert fails", async () => {
    const slug = `ops-${randomUUID().slice(0, 8)}`;
    const r = await attempt(db.platform, null,
      "select * from platform_create_tenant_with_owner($1, 'Ops', 'central', null, null, 'Asia/Kolkata', null, 'nope', 'x', null, 'Owner')", [slug]);
    assert.ok(!r.ok && r.code === "23514", JSON.stringify(r));
    const left = await db.owner.query("select 1 from tenants where slug = $1", [slug]);
    assert.equal(left.rowCount, 0);
  });
});

describe("SQL hygiene in application code (SEC-003 compensating control)", () => {
  // Only withTenant (packages/db/src/tenant.ts) may change the tenant, principal or proof settings. Any other set_config or SET of
  // app.* in application source is a way to retarget RLS and fails here.
  it("no set_config / SET app.* outside packages/db/src/tenant.ts", async () => {
    const root = path.resolve(import.meta.dirname, "..", "..", "..");
    const offenders: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) {
          const text = await readFile(p, "utf8");
          // Comment lines may mention it; code may not.
          const code = text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
          if (/set_config\s*\(|\bset\s+(local\s+)?app\./i.test(code)) offenders.push(path.relative(root, p).replace(/\\/g, "/"));
        }
      }
    }
    for (const top of ["apps", "packages"]) {
      for (const pkg of await readdir(path.join(root, top), { withFileTypes: true }).catch(() => [])) {
        if (pkg.isDirectory()) await walk(path.join(root, top, pkg.name, "src"));
      }
    }
    assert.deepEqual(offenders.filter((f) => f !== "packages/db/src/tenant.ts"), []);
  });
});
