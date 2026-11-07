import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { checkDatabase, createPool, listTenantTables, resolveDatabaseUrls, TEST_DATABASE, withTenant } from "../src/index.ts";
import { FIXTURE, insertFixture, type Ids } from "./fixture.ts";
import { attempt, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// (a) Tenant isolation. Tenant A's context must not read, update, delete, or insert-for-tenant-B on ANY tenant table.
// Tables are enumerated from the catalog, so a new table without RLS (or without a fixture here) fails.

let db: TestDb;
let A: string;
let B: string;
let idsA: Ids;
let idsB: Ids;
let tables: string[] = [];
const keyCol = (table: string) => (table === "tenants" ? "id" : "tenant_id");

before(async () => {
  db = await connectTestDb();
  A = await createTenant(db, "rls-a");
  B = await createTenant(db, "rls-b");
  idsA = await withTenant(db.app, A, (c) => insertFixture(c, A));
  idsB = await withTenant(db.app, B, (c) => insertFixture(c, B));
  tables = (await listTenantTables(db.owner)).map((t) => t.table);
});

after(async () => {
  await db.close();
});

describe("catalog", () => {
  it("every table with a tenant_id column (and tenants) has RLS enabled, forced and a tenant policy", async () => {
    const info = await listTenantTables(db.owner);
    assert.ok(info.length >= 30, `expected at least 30 tenant tables, found ${info.length}`);
    const bad = info.filter((t) => !t.rlsEnabled || !t.rlsForced || t.tenantPolicies.length === 0);
    assert.deepEqual(bad.map((t) => t.table), [], "tables without forced RLS and a current_tenant_id() policy");
  });

  it("the isolation fixture covers every tenant table (add a FIXTURE entry for new tables)", () => {
    const covered = new Set(["tenants", ...FIXTURE.map((f) => f.table)]);
    const missing = tables.filter((t) => !covered.has(t));
    assert.deepEqual(missing, [], "tenant tables with no fixture row in test/fixture.ts");
    const stale = FIXTURE.map((f) => f.table).filter((t) => !tables.includes(t));
    assert.deepEqual(stale, [], "fixture entries for tables that no longer exist");
  });

  it("the runtime role is not superuser, has no BYPASSRLS and owns nothing", async () => {
    const urls = resolveDatabaseUrls(TEST_DATABASE);
    const appPool = createPool({ connectionString: urls.appUrl, max: 1 });
    try {
      const results = await checkDatabase(appPool, db.owner);
      const failed = results.filter((r) => !r.ok);
      assert.deepEqual(failed, []);
    } finally {
      await appPool.end();
    }
  });
});

describe("tenant A cannot touch tenant B (runtime role qenbel_app)", () => {
  for (const entry of [{ table: "tenants" }, ...FIXTURE]) {
    const table = entry.table;
    describe(table, () => {
      it("read: sees only its own rows, none of B's", async () => {
        const own = await withTenant(db.app, A, async (c) =>
          (await c.query<{ n: string }>(`select count(*)::text as n from ${table} where ${keyCol(table)} = $1`, [A])).rows[0]?.n);
        assert.equal(own, "1", "tenant A should see its own fixture row (policy must not hide everything)");
        const other = await withTenant(db.app, A, async (c) =>
          (await c.query<{ n: string }>(`select count(*)::text as n from ${table} where ${keyCol(table)} = $1`, [B])).rows[0]?.n);
        assert.equal(other, "0", `tenant A can read tenant B rows in ${table}`);
        const all = await withTenant(db.app, A, async (c) =>
          (await c.query<{ n: string }>(`select count(*)::text as n from ${table} where ${keyCol(table)} <> $1`, [A])).rows[0]?.n);
        assert.equal(all, "0", `unfiltered select in ${table} returned rows of another tenant`);
      });

      it("update: changes zero rows of B (or is denied by grants)", async () => {
        const r = await attempt(db.app, A, `update ${table} set ${keyCol(table)} = ${keyCol(table)} where ${keyCol(table)} = $1`, [B]);
        if (r.ok) assert.equal(r.rowCount, 0, `tenant A updated rows of tenant B in ${table}`);
        else assert.ok(["42501"].includes(r.code), `unexpected error ${r.code}: ${r.message}`);
      });

      it("delete: removes zero rows of B (or is denied by grants)", async () => {
        const r = await attempt(db.app, A, `delete from ${table} where ${keyCol(table)} = $1`, [B]);
        if (r.ok) assert.equal(r.rowCount, 0, `tenant A deleted rows of tenant B in ${table}`);
        else assert.ok(["42501"].includes(r.code), `unexpected error ${r.code}: ${r.message}`);
      });

      it("insert for B from A's context is rejected and leaves B unchanged", async () => {
        const before = await withTenant(db.app, B, async (c) =>
          (await c.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n);
        let failure: { code?: string; message: string } | undefined;
        try {
          await withTenant(db.app, A, async (c) => {
            if (table === "tenants") {
              await c.query("insert into tenants (id, slug, name) values ($1, $2, 'x')", [randomUUID(), `x-${randomUUID().slice(0, 8)}`]);
            } else {
              const spec = FIXTURE.find((f) => f.table === table);
              assert.ok(spec);
              await insertRow(c, table, spec.row(B, idsB));
            }
          });
        } catch (err) {
          failure = err as { code?: string; message: string };
        }
        assert.ok(failure, `tenant A inserted a row for tenant B into ${table}`);
        // 42501: RLS WITH CHECK / missing grant. 23503: a guard trigger could not see B's parent row from A's context.
        assert.ok(["42501", "23503"].includes(failure.code ?? ""), `unexpected error ${failure.code}: ${failure.message}`);
        const after = await withTenant(db.app, B, async (c) =>
          (await c.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0]?.n);
        assert.equal(after, before);
      });
    });
  }
});

describe("tenant A cannot touch tenant B (owner role, FORCE RLS: proves the policy itself, independent of grants)", () => {
  for (const entry of [{ table: "tenants" }, ...FIXTURE]) {
    const table = entry.table;
    it(`${table}: select, update and delete see zero rows of B; cross insert is rejected`, async () => {
      const sel = await attempt(db.owner, A, `select 1 from ${table} where ${keyCol(table)} = $1`, [B]);
      assert.ok(sel.ok && sel.rowCount === 0, "owner read B rows from A's context");
      const upd = await attempt(db.owner, A, `update ${table} set ${keyCol(table)} = ${keyCol(table)} where ${keyCol(table)} = $1`, [B]);
      assert.ok(upd.ok && upd.rowCount === 0, `owner updated B rows (${JSON.stringify(upd)})`);
      const del = await attempt(db.owner, A, `delete from ${table} where ${keyCol(table)} = $1`, [B]);
      assert.ok(del.ok && del.rowCount === 0, `owner deleted B rows (${JSON.stringify(del)})`);
      const ownSel = await attempt(db.owner, A, `select 1 from ${table} where ${keyCol(table)} = $1`, [A]);
      assert.ok(ownSel.ok && ownSel.rowCount === 1, "owner should see A's own row in A's context");

      let code: string | undefined;
      try {
        await withTenant(db.owner, A, async (c) => {
          if (table === "tenants") {
            await c.query("insert into tenants (id, slug, name) values ($1, $2, 'x')", [randomUUID(), `y-${randomUUID().slice(0, 8)}`]);
          } else {
            const spec = FIXTURE.find((f) => f.table === table);
            assert.ok(spec);
            await insertRow(c, table, spec.row(B, idsB));
          }
        });
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      assert.ok(code === "42501" || code === "23503", `owner cross-tenant insert into ${table} was not rejected (code ${code})`);
    });
  }
});

describe("no tenant context means no rows", () => {
  it("a plain connection with no app.tenant_id sees zero rows in every tenant table", async () => {
    for (const table of tables) {
      const res = await db.app.query<{ n: string }>(`select count(*)::text as n from ${table}`);
      assert.equal(res.rows[0]?.n, "0", `${table} returned rows with no tenant set`);
    }
  });

  it("an empty or unknown tenant id yields zero rows, not an error", async () => {
    for (const setting of ["", randomUUID()]) {
      const rows = await withTenant(db.app, A, async (c) => {
        await c.query("select set_config('app.tenant_id', $1, true)", [setting]);
        return (await c.query<{ n: string }>("select (select count(*) from customers)::text as n")).rows[0]?.n;
      });
      assert.equal(rows, "0");
    }
  });

  it("the tenant setting does not leak to the next user of a pooled connection", async () => {
    const urls = resolveDatabaseUrls(TEST_DATABASE);
    const single = createPool({ connectionString: urls.appUrl, max: 1 });
    try {
      const seen = await withTenant(single, A, async (c) => (await c.query<{ n: string }>("select count(*)::text as n from customers")).rows[0]?.n);
      assert.equal(seen, "1");
      const after = await single.query<{ n: string; t: string | null }>(
        "select (select count(*) from customers)::text as n, current_setting('app.tenant_id', true) as t");
      assert.equal(after.rows[0]?.n, "0");
      assert.ok(!after.rows[0]?.t, "app.tenant_id must be reset after the transaction");
    } finally {
      await single.end();
    }
  });

  it("insert with no tenant context is rejected", async () => {
    const r = await attempt(db.app, null, "insert into customers (tenant_id, name) values ($1, 'x')", [A]);
    assert.ok(!r.ok && r.code === "42501", JSON.stringify(r));
  });

  it("withTenant refuses a non-UUID tenant id", async () => {
    await assert.rejects(withTenant(db.app, "not-a-uuid", async () => 1), TypeError);
    await assert.rejects(withTenant(db.app, "' or 1=1 --", async () => 1), TypeError);
  });
});

describe("targeted isolation behaviours", () => {
  it("A can update its own rows (positive control)", async () => {
    const r = await attempt(db.app, A, "update customers set name = 'Renamed' where id = $1", [idsA.customers]);
    assert.ok(r.ok && r.rowCount === 1, JSON.stringify(r));
  });

  it("A cannot move its own row to tenant B (WITH CHECK)", async () => {
    const r = await attempt(db.app, A, "update customers set tenant_id = $1 where id = $2", [B, idsA.customers]);
    assert.ok(!r.ok && r.code === "42501", JSON.stringify(r));
  });

  it("composite foreign keys stop a row in A from pointing at B's rows even when RLS would not", async () => {
    // Owner context A, explicit parent from B: the composite FK (tenant_id, customer_id) finds no match.
    const r = await attempt(db.owner, A,
      "insert into customer_tags (tenant_id, customer_id, tag) values ($1, $2, 'cross')", [A, idsB.customers]);
    assert.ok(!r.ok && r.code === "23503", JSON.stringify(r));
  });

  it("A cannot read B's tenant row, and can read and edit its own limited columns", async () => {
    const own = await withTenant(db.app, A, async (c) => (await c.query("select id from tenants")).rows.map((r) => r.id));
    assert.deepEqual(own, [A]);
    const edit = await attempt(db.app, A, "update tenants set name = 'Renamed tenant' where id = $1", [A]);
    assert.ok(edit.ok && edit.rowCount === 1, JSON.stringify(edit));
    const status = await attempt(db.app, A, "update tenants set status = 'suspended' where id = $1", [A]);
    assert.ok(!status.ok && status.code === "42501", "a tenant must not change its own status");
  });

  it("platform functions are the only cross-tenant path: credential lookup returns the owning tenant", async () => {
    const res = await db.auth.query<{ tenant_id: string }>("select tenant_id from auth_lookup_credential($1)", [
      (await withTenant(db.app, B, async (c) => (await c.query<{ lookup_id: string }>("select lookup_id from api_credentials")).rows[0]?.lookup_id)) as string,
    ]);
    assert.equal(res.rows[0]?.tenant_id, B);
    const missing = await db.auth.query("select * from auth_lookup_credential('nope-nope-nope')");
    assert.equal(missing.rowCount, 0);
    const users = await db.auth.query<{ tenant_id: string }>("select tenant_id from auth_lookup_user('dev', 'dev|nobody')");
    assert.equal(users.rowCount, 0);
    const admin = await db.auth.query<{ ok: boolean }>("select auth_is_platform_admin('dev', 'dev|nobody') as ok");
    assert.equal(admin.rows[0]?.ok, false);
  });

  it("the runtime role cannot read platform_admins or call SQL it should not have", async () => {
    const r = await attempt(db.app, null, "select * from platform_admins");
    assert.ok(!r.ok && r.code === "42501");
    const t = await attempt(db.app, null, "truncate table customers");
    assert.ok(!t.ok && t.code === "42501");
    const ddl = await attempt(db.app, null, "create table should_not_exist (id int)");
    assert.ok(!ddl.ok && ddl.code === "42501");
  });
});
