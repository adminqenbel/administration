// Security PoC: database tenant isolation, roles, SECURITY DEFINER functions.
//
// Run:  node docs/security/poc/setup-scratch-db.mjs   (once; creates the scratch database)
//       node --test docs/security/poc/db-isolation.test.ts
//
// Touches ONLY the scratch database qenbel_admin_sec_test (checked at start-up). Credentials come from infra/.env
// through @qenbel/db and are never printed.
//
// Test names start with a tag:
//   [GUARD]  regression guard. Passes today; must keep passing.
//   [DEFECT SEC-nnn]  demonstrates a real defect. It asserts the SAFE behaviour, so it FAILS today. It is marked
//            `todo`, so node:test reports it as "not ok ... # TODO" without failing the run. Remove `todo` once fixed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  configureTenantProof, createPool, createTestTenant, resolveDatabaseUrls, runMigrations, setTestTenantStatus, withTenant,
  withTestAuthClient, withTestPlatformClient, type Pool,
} from "@qenbel/db";

const SCRATCH = "qenbel_admin_sec_test";
// Never let a stray environment variable point these tests at another database.
for (const v of ["DATABASE_URL", "DATABASE_MIGRATE_URL", "TEST_DATABASE_URL", "TEST_DATABASE_MIGRATE_URL"]) delete process.env[v];

let app: Pool; // qenbel_app (runtime role, subject to RLS)
let owner: Pool; // qenbel_migrate (owns the schema)
let tenantA = "";
let tenantB = "";
let custA = "";
let custB = "";
let credB = "";

async function mkTenant(label: string): Promise<string> {
  const slug = `sec-${label}-${randomUUID().slice(0, 8)}`;
  return createTestTenant(app, { slug, name: `Sec ${slug}` });
}

before(async () => {
  const urls = resolveDatabaseUrls(SCRATCH);
  owner = createPool({ connectionString: urls.migrateUrl, max: 2, applicationName: "sec-poc-owner" });
  app = createPool({ connectionString: urls.appUrl, max: 4, applicationName: "sec-poc-app" });
  const who = await owner.query<{ db: string }>("select current_database() as db");
  assert.equal(who.rows[0]?.db, SCRATCH, "refusing to run: not the scratch database");
  await runMigrations(owner);
  // SEC-003 mitigation (migration 021): this scratch database runs with the signed tenant context switched on, the way
  // a production database is meant to. withTenant() signs app.tenant_id with the same key.
  const proofKey = randomBytes(32);
  await withTestPlatformClient(app, (c) => c.query("select platform_set_tenant_proof_keys($1)", [proofKey]));
  configureTenantProof(proofKey);

  tenantA = await mkTenant("a");
  tenantB = await mkTenant("b");
  custA = randomUUID();
  custB = randomUUID();
  credB = randomUUID();
  await withTenant(app, tenantA, (c) =>
    c.query("insert into customers (id, tenant_id, name, phone) values ($1, $2, 'Alice A', '+919000000001')", [custA, tenantA]),
  );
  await withTenant(app, tenantB, async (c) => {
    await c.query("insert into customers (id, tenant_id, name, phone) values ($1, $2, 'Bob B', '+919000000002')", [custB, tenantB]);
    await c.query(
      `insert into api_credentials (id, tenant_id, credential_type, name, lookup_id, secret_hash, tool_scopes)
       values ($1, $2, 'api_key', 'poc key', $3, $4, '{get_catalogue}')`,
      [credB, tenantB, `qbk_poc${randomUUID().slice(0, 8)}`, "a".repeat(64)],
    );
  });
});

after(async () => {
  await withTestPlatformClient(app, (c) => c.query("select platform_clear_tenant_proof_keys()")).catch(() => undefined);
  await Promise.allSettled([app?.end(), owner?.end()]);
});

describe("tenant isolation (RLS)", () => {
  test("[GUARD] every table with a tenant_id column has RLS enabled, forced, and a policy", async () => {
    const res = await owner.query<{ t: string; rls: boolean; forced: boolean; policies: string }>(
      `select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
              (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind = 'r'`,
    );
    assert.ok(res.rows.length >= 30, "expected the tenant tables");
    const bad = res.rows.filter((r) => !r.rls || !r.forced || Number(r.policies) < 1).map((r) => r.t);
    assert.deepEqual(bad, []);
  });

  test("[GUARD] a tenant sees only its own rows; no tenant context sees nothing", async () => {
    const a = await withTenant(app, tenantA, (c) => c.query("select id from customers"));
    assert.deepEqual(a.rows.map((r) => (r as { id: string }).id), [custA]);
    const none = await app.query("select id from customers");
    assert.equal(none.rowCount, 0);
  });

  test("[GUARD] cross-tenant INSERT and UPDATE are refused or touch zero rows", async () => {
    await assert.rejects(
      withTenant(app, tenantA, (c) => c.query("insert into customers (tenant_id, name) values ($1, 'x')", [tenantB])),
      /row-level security/,
    );
    const upd = await withTenant(app, tenantA, (c) => c.query("update customers set name = 'pwned' where id = $1", [custB]));
    assert.equal(upd.rowCount, 0);
  });

  test("[GUARD] composite foreign keys stop a row in tenant A from pointing at tenant B's customer", async () => {
    await assert.rejects(
      withTenant(app, tenantA, (c) =>
        c.query(
          `insert into bookings (tenant_id, customer_id, status, source_channel, starts_at, ends_at)
           values ($1, $2, 'CONFIRMED', 'api', now(), now() + interval '1 hour')`,
          [tenantA, custB],
        ),
      ),
      (err: { code?: string }) => err.code === "23503",
    );
  });

  test("[GUARD] app.tenant_id does not leak to the next user of a pooled connection (commit and error paths)", async () => {
    const one = createPool({ connectionString: resolveDatabaseUrls(SCRATCH).appUrl, max: 1 });
    try {
      await withTenant(one, tenantA, async (c) => void (await c.query("select 1")));
      let seen = await one.query<{ t: string | null }>("select current_setting('app.tenant_id', true) as t");
      assert.ok(!seen.rows[0]?.t, "setting must be empty after COMMIT");
      await assert.rejects(
        withTenant(one, tenantA, async (c) => {
          await c.query("select 1");
          throw new Error("boom");
        }),
        /boom/,
      );
      seen = await one.query("select current_setting('app.tenant_id', true) as t");
      assert.ok(!seen.rows[0]?.t, "setting must be empty after ROLLBACK");
      const rows = await one.query("select id from customers");
      assert.equal(rows.rowCount, 0);
    } finally {
      await one.end();
    }
  });
});

describe("runtime role privileges", () => {
  test("[GUARD] qenbel_app is not superuser, not BYPASSRLS, cannot SET ROLE, cannot create objects", async () => {
    const r = await app.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      "select rolsuper, rolbypassrls, rolcreaterole from pg_roles where rolname = current_user",
    );
    assert.deepEqual(r.rows[0], { rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    await assert.rejects(app.query("set role qenbel_platform"), /permission denied|must be member/i);
    await assert.rejects(app.query("set role qenbel_migrate"), /permission denied|must be member/i);
    await assert.rejects(app.query("create table sec_poc_x (id int)"), /permission denied/i);
  });

  test("[GUARD] qenbel_app cannot rewrite the audit log, edit ledger amounts, or delete bookings", async () => {
    await withTenant(app, tenantA, async (c) => {
      await c.query("insert into audit_log (tenant_id, actor_kind, action) values ($1, 'system', 'poc')", [tenantA]);
    });
    await assert.rejects(withTenant(app, tenantA, (c) => c.query("update audit_log set action = 'x'")), /permission denied|append-only/);
    await assert.rejects(withTenant(app, tenantA, (c) => c.query("delete from audit_log")), /permission denied|append-only/);
    await assert.rejects(withTenant(app, tenantA, (c) => c.query("update payments set amount_paise = 1")), /permission denied/);
    await assert.rejects(withTenant(app, tenantA, (c) => c.query("delete from bookings")), /permission denied/);
    await assert.rejects(withTenant(app, tenantA, (c) => c.query("select * from platform_admins")), /permission denied/);
  });
});

describe("SECURITY DEFINER functions", () => {
  test("[GUARD] every SECURITY DEFINER function is owned by qenbel_platform and pins search_path with pg_temp last", async () => {
    const res = await owner.query<{ fn: string; owner: string; cfg: string[] | null; public_exec: boolean }>(
      `select p.oid::regprocedure::text as fn, pg_get_userbyid(p.proowner) as owner, p.proconfig as cfg,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                       where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef`,
    );
    assert.ok(res.rows.length >= 7);
    for (const r of res.rows) {
      assert.equal(r.owner, "qenbel_platform", `${r.fn} owner`);
      const sp = (r.cfg ?? []).find((c) => c.startsWith("search_path="));
      assert.ok(sp?.endsWith("pg_temp"), `${r.fn} must pin search_path ending in pg_temp (got ${sp})`);
    }
  });

  test(
    "[DEFECT SEC-001] SECURITY DEFINER functions are not executable by PUBLIC (the REVOKE in migration 011 is a silent no-op)",
    // Fixed by migration 017. current_tenant_id() is the one deliberate PUBLIC function (every policy calls it); since 021 it is a
    // definer so it can read the tenant-proof key, and it only ever returns the caller's own, verified tenant.
    async () => {
      const res = await owner.query<{ fn: string }>(
        `select p.oid::regprocedure::text as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prosecdef and p.proname <> 'current_tenant_id'
            and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
      );
      assert.deepEqual(res.rows.map((r) => r.fn), [], "PUBLIC can execute these SECURITY DEFINER functions");
    },
  );

  test("[GUARD] functions in schema public: only current_tenant_id() is PUBLIC-executable", async () => {
    const res = await owner.query<{ fn: string }>(
      `select p.oid::regprocedure::text as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
    );
    assert.deepEqual(res.rows.map((r) => r.fn).sort(), ["current_tenant_id()"]);
  });

  // ---- the application role can reach the platform-level functions (SEC-002) ----------------------------------

  test(
    "[DEFECT SEC-002] code running as qenbel_app inside tenant A cannot suspend tenant B",
    // Fixed by migration 017 (no EXECUTE for qenbel_app).
    async () => {
      try {
        let suspended = false;
        try {
          await withTenant(app, tenantA, (c) => c.query("select platform_set_tenant_status($1, 'suspended')", [tenantB]));
          suspended = true;
        } catch {
          suspended = false;
        }
        assert.equal(suspended, false, "tenant A's session suspended tenant B through platform_set_tenant_status()");
      } finally {
        await setTestTenantStatus(app, tenantB, "active");
      }
    },
  );

  test(
    "[DEFECT SEC-002] code running as qenbel_app inside tenant A cannot expire tenant B's holds by passing a future 'now'",
    // Fixed by migration 017 (no EXECUTE for qenbel_app, and the sweep no longer takes a clock).
    async () => {
      const bookingId = randomUUID();
      const resId = randomUUID();
      await withTenant(app, tenantB, async (c) => {
        await c.query("insert into resources (id, tenant_id, type, name) values ($1, $2, 'staff', 'R')", [resId, tenantB]);
        await c.query(
          `insert into bookings (id, tenant_id, status, source_channel, starts_at, ends_at, hold_expires_at)
           values ($1, $2, 'HOLD', 'web_chat', now() + interval '2 days', now() + interval '2 days 1 hour', now() + interval '10 minutes')`,
          [bookingId, tenantB],
        );
      });
      await withTenant(app, tenantA, (c) => c.query("select expire_booking_holds('2999-01-01T00:00:00Z')")).catch(() => undefined);
      const after = await withTenant(app, tenantB, (c) => c.query<{ status: string }>("select status from bookings where id = $1", [bookingId]));
      assert.equal(after.rows[0]?.status, "HOLD", "tenant A's session expired tenant B's live hold");
    },
  );

  test(
    "[DEFECT SEC-002] code running as qenbel_app inside tenant A cannot read tenant B's API key hash",
    // Fixed by migration 017 (only qenbel_auth may execute it).
    async () => {
      const lookup = (await owner.query<{ lookup_id: string }>("select lookup_id from api_credentials where id = $1", [credB])).rows[0]?.lookup_id;
      // 'owner' is subject to FORCE RLS and sees nothing, so read the lookup id the way the test created it: from tenant B's own session.
      const lookupId =
        lookup ?? (await withTenant(app, tenantB, (c) => c.query<{ lookup_id: string }>("select lookup_id from api_credentials where id = $1", [credB]))).rows[0]?.lookup_id;
      let leaked: string | null = null;
      try {
        const r = await withTenant(app, tenantA, (c) => c.query<{ secret_hash: string }>("select secret_hash from auth_lookup_credential($1)", [lookupId]));
        leaked = r.rows[0]?.secret_hash ?? null;
      } catch {
        leaked = null;
      }
      assert.equal(leaked, null, "tenant A's session obtained tenant B's credential hash");
    },
  );

  test(
    "[DEFECT SEC-003] SQL running in tenant A's transaction cannot switch to tenant B with set_config (blast radius of any SQL injection)",
    // Passes with the signed tenant context of migration 021 switched on (see before()). In a database without a key installed the
    // tenant is still an ordinary setting and this would fail; see REVIEW-stage2.md status table.
    async () => {
      const rows = await withTenant(app, tenantA, async (c) => {
        await c.query("select set_config('app.tenant_id', $1, true)", [tenantB]);
        return c.query("select id from customers");
      });
      assert.equal(
        rows.rows.some((r) => (r as { id: string }).id === custB),
        false,
        "tenant A's transaction read tenant B's customer after set_config",
      );
    },
  );
});

describe("identity and state", () => {
  test(
    "[DEFECT SEC-013] one external identity maps to at most one tenant membership (otherwise the API picks an arbitrary tenant)",
    // Fixed by migration 020: one active membership per identity (the second insert is refused), deterministic lookup.
    async () => {
      const subject = `user_sec${randomUUID().slice(0, 8).replace(/-/g, "")}`;
      for (const t of [tenantA, tenantB]) {
        await withTenant(app, t, (c) =>
          c.query("insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'clerk', $2, 'Dual', 'STAFF')", [t, subject]),
        ).catch((err: { code?: string }) => assert.equal(err.code, "23505", "the second membership must be refused as a unique violation"));
      }
      const r = await withTestAuthClient(app, (c) => c.query("select tenant_id from auth_lookup_user('clerk', $1)", [subject]));
      assert.ok((r.rowCount ?? 0) <= 1, `${r.rowCount} memberships returned for one sign-in; apps/api authentication.service.ts uses rows[0] with no ORDER BY`);
    },
  );

  test(
    "[DEFECT SEC-011] the database itself does not enforce order/booking state machines or ledger consistency (a tenant-scoped statement can jump DRAFT -> FULFILLED or mark an order paid with no payment row)",
    { todo: "SEC-011: transitions and payment_status are enforced only in TypeScript; defence in depth would be a trigger" },
    async () => {
      const id = randomUUID();
      await withTenant(app, tenantA, (c) =>
        c.query("insert into orders (id, tenant_id, source_channel) values ($1, $2, 'api')", [id, tenantA]),
      );
      let jumped = false;
      try {
        await withTenant(app, tenantA, (c) => c.query("update orders set status = 'FULFILLED', payment_status = 'paid' where id = $1", [id]));
        jumped = true;
      } catch {
        jumped = false;
      }
      assert.equal(jumped, false, "DRAFT -> FULFILLED + paid with no ledger entry was accepted by the database");
    },
  );
});

describe("webhook endpoint URLs", () => {
  test(
    "[DEFECT SEC-012] the database accepts a webhook URL that points at the cloud metadata service or localhost",
    // Fixed in the database by migration 019 (the dispatcher must still resolve and re-check at delivery time).
    async () => {
      let accepted = 0;
      for (const url of ["http://169.254.169.254/latest/meta-data/", "http://localhost:5432/", "http://10.0.0.5/admin"]) {
        try {
          await withTenant(app, tenantA, (c) =>
            c.query(
              `insert into webhook_endpoints (tenant_id, url, secret_ciphertext, events)
               values ($1, $2, 'x', '{booking.created}')`,
              [tenantA, url],
            ),
          );
          accepted++;
        } catch {
          // refused: good
        }
      }
      assert.equal(accepted, 0, `${accepted} internal URLs were stored`);
    },
  );
});
