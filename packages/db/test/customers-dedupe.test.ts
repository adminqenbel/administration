import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_MIGRATIONS_DIR } from "../src/index.ts";
import { attempt, connectTestDb, createTenant, insertRow, type TestDb } from "./helpers.ts";

// Migration 014: one active customer per (tenant, phone) and per (tenant, lower(email)).

let db: TestDb;
let A: string;
let B: string;

before(async () => {
  db = await connectTestDb({ max: 16 });
  A = await createTenant(db, "dedupe-a");
  B = await createTenant(db, "dedupe-b");
});
after(async () => {
  await db.close();
});

const add = (tenant: string, v: { name?: string; phone?: string | null; email?: string | null; archived?: boolean }) =>
  attempt(db.app, tenant, "insert into customers (tenant_id, name, phone, email, archived_at) values ($1, $2, $3, $4, $5)",
    [tenant, v.name ?? "C", v.phone ?? null, v.email ?? null, v.archived ? new Date() : null]);
const code = (r: Awaited<ReturnType<typeof add>>) => (r.ok ? null : r.code);

describe("customers: active phone and e-mail are unique per tenant", () => {
  it("a second active customer with the same phone is rejected (23505, named index)", async () => {
    assert.equal((await add(A, { phone: "+919111100001" })).ok, true);
    const r = await add(A, { phone: "+919111100001" });
    assert.equal(code(r), "23505");
    assert.match(r.ok ? "" : r.message, /customers_active_phone_unique/);
  });

  it("e-mail is compared case-insensitively", async () => {
    assert.equal((await add(A, { email: "Dedupe.One@Example.com" })).ok, true);
    const r = await add(A, { email: "dedupe.one@example.COM" });
    assert.equal(code(r), "23505");
    assert.match(r.ok ? "" : r.message, /customers_active_email_unique/);
  });

  it("customers without a phone or e-mail never collide", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await add(A, { name: `Walk-in ${i}` })).ok, true);
  });

  it("the same phone or e-mail is fine in another tenant", async () => {
    assert.equal((await add(B, { phone: "+919111100001", email: "dedupe.one@example.com" })).ok, true);
  });

  it("archived customers do not count, and archiving frees the value", async () => {
    assert.equal((await add(A, { phone: "+919111100002", archived: true })).ok, true);
    assert.equal((await add(A, { phone: "+919111100002" })).ok, true, "a new active customer may reuse an archived number");
    assert.equal((await add(A, { phone: "+919111100002", archived: true })).ok, true, "several archived rows may share it");
    const archive = await attempt(db.app, A, "update customers set archived_at = now() where phone = '+919111100001' and archived_at is null");
    assert.equal(archive.ok, true);
    assert.equal((await add(A, { phone: "+919111100001" })).ok, true);
  });

  it("restoring an archived customer whose number has been reused is rejected", async () => {
    const r = await attempt(db.app, A, "update customers set archived_at = null where phone = '+919111100001' and archived_at is not null");
    assert.equal(r.ok ? null : r.code, "23505");
  });

  it("updating a phone onto an existing active number is rejected", async () => {
    assert.equal((await add(A, { name: "Mover", phone: "+919111100003" })).ok, true);
    const r = await attempt(db.app, A, "update customers set phone = '+919111100002' where phone = '+919111100003'");
    assert.equal(r.ok ? null : r.code, "23505");
  });

  it("concurrent inserts of one phone: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => add(A, { phone: "+919111100099", email: "race@example.com" })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    for (const r of results.filter((x) => !x.ok)) assert.equal(code(r), "23505");
  });
});

// The duplicate clean-up inside 014 runs once, at migration time. To test it, run the migration file again inside
// a transaction that is rolled back: drop the new indexes, plant duplicates, execute the file, inspect, roll back.
describe("migration 014 clears pre-existing duplicates safely", () => {
  it("keeps the oldest active customer's value, nulls the others and records what was removed", async () => {
    const sql = await readFile(path.join(DEFAULT_MIGRATIONS_DIR, "014_customer_dedupe.sql"), "utf8");
    const t = await createTenant(db, "dedupe-mig");
    const c = await db.owner.connect();
    try {
      await c.query("begin");
      await c.query("alter table customers no force row level security");
      await c.query("drop index customers_active_phone_unique");
      await c.query("drop index customers_active_email_unique");
      const mk = (name: string, phone: string | null, email: string | null, createdAt: string, archived = false) =>
        insertRow(c, "customers", { tenant_id: t, name, phone, email, created_at: createdAt, archived_at: archived ? new Date() : null });
      const oldest = await mk("oldest", "+919222200001", "Same@Example.com", "2030-01-01T00:00:00Z");
      const dupPhone = await mk("dup-phone", "+919222200001", "other@example.com", "2030-01-02T00:00:00Z");
      const dupBoth = await mk("dup-both", "+919222200001", "same@example.com", "2030-01-03T00:00:00Z");
      const archived = await mk("archived", "+919222200001", "same@example.com", "2029-01-01T00:00:00Z", true);
      const unique = await mk("unique", "+919222200002", null, "2030-01-04T00:00:00Z");

      await c.query(sql);
      await c.query("alter table customers no force row level security");   // 014 forces it again; reading as owner needs it open

      type Dedupe = Record<string, { value: string; keptCustomerId: string; migration: string }>;
      const rows = new Map((await c.query<{ id: string; phone: string | null; email: string | null; attributes: { dedupe?: Dedupe } }>(
        "select id, phone, email, attributes from customers where tenant_id = $1", [t])).rows.map((r) => [r.id, r]));
      assert.equal(rows.get(oldest)?.phone, "+919222200001");
      assert.equal(rows.get(oldest)?.email, "Same@Example.com");
      assert.equal(rows.get(oldest)?.attributes.dedupe, undefined);

      assert.equal(rows.get(dupPhone)?.phone, null);
      assert.equal(rows.get(dupPhone)?.email, "other@example.com", "only the duplicated field is cleared");
      assert.deepEqual(rows.get(dupPhone)?.attributes.dedupe?.phone, { value: "+919222200001", keptCustomerId: oldest, migration: "014" });

      assert.equal(rows.get(dupBoth)?.phone, null);
      assert.equal(rows.get(dupBoth)?.email, null);
      assert.equal(rows.get(dupBoth)?.attributes.dedupe?.phone?.keptCustomerId, oldest);
      assert.equal(rows.get(dupBoth)?.attributes.dedupe?.email?.value, "same@example.com");

      assert.equal(rows.get(archived)?.phone, "+919222200001", "archived rows are never touched");
      assert.equal(rows.get(unique)?.phone, "+919222200002");
      assert.equal(rows.size, 5, "nothing is deleted");

      // the indexes exist again and bite
      await c.query("savepoint s");
      await assert.rejects(c.query("insert into customers (tenant_id, name, phone) values ($1, 'x', '+919222200001')", [t]), { code: "23505" });
      await c.query("rollback to savepoint s");
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
    // the real indexes and FORCE are back after the rollback
    const idx = await db.owner.query("select indexname from pg_indexes where indexname in ('customers_active_phone_unique', 'customers_active_email_unique')");
    assert.equal(idx.rowCount, 2);
    const forced = await db.owner.query("select relforcerowsecurity from pg_class where relname = 'customers'");
    assert.equal(forced.rows[0]?.relforcerowsecurity, true);
  });
});
