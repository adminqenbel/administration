// The database now refuses two active customers with one phone or one lower(email) per tenant (migration 014). The engine
// still dedupes first (advisory locks + lookup); these tests race it against writers that do NOT take those locks, which
// is the only way the database constraint can fire.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { withTenant } from "@qenbel/db";
import { AppError } from "@qenbel/shared";
import { archiveCustomer, createCustomer, restoreCustomer, updateCustomer } from "../src/index.ts";
import { call, connectTestDb, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";
import { mapPgError } from "../src/common.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const phone = (n: number) => `+9198${String(70000000 + n)}`;

async function rawInsert(c: { query: (t: string, v?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> }, tenantId: string, name: string, p: string | null, email: string | null = null): Promise<string> {
  const r = await c.query("insert into customers (tenant_id, name, phone, email, source) values ($1, $2, $3, $4, 'api') returning id", [tenantId, name, p, email]);
  return (r.rows[0] as { id: string }).id;
}

/**
 * Hold a transaction open that has inserted a customer (so its unique-index entry is pending), run `during` in the engine
 * once the engine's own statement is blocked on it, then commit. Returns the engine's outcome.
 */
async function raceAgainstRawInsert<T>(
  tenantId: string,
  insert: (c: Parameters<typeof rawInsert>[0]) => Promise<string>,
  during: () => Promise<T>,
): Promise<{ rawId: string; outcome: PromiseSettledResult<T> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inserted!: (id: string) => void;
  const insertedId = new Promise<string>((r) => (inserted = r));
  const holder = withTenant(db.app, tenantId, async (c) => {
    inserted(await insert(c as never));
    await gate;
  });
  const rawId = await insertedId;
  const running = during();
  // wait until the engine is really blocked on the pending index entry, then let the raw writer commit
  const deadline = Date.now() + 8000;
  for (;;) {
    const waiting = await db.owner.query("select 1 from pg_locks where locktype = 'transactionid' and not granted");
    if (waiting.rows.length > 0) break;
    if (Date.now() > deadline) throw new Error("the engine never blocked on the raw insert");
    await new Promise((r) => setTimeout(r, 20));
  }
  release();
  await holder;
  const [outcome] = await Promise.allSettled([running]);
  return { rawId, outcome };
}

describe("database-level duplicate protection racing the engine", () => {
  test("createCustomer loses a race against a raw insert of the same phone: it answers as a dedupe, not an error, and the transaction survives", async () => {
    const t = await db.createTenant("cu-race-create");
    const ctx = makeCtx(t);
    const p = phone(1);
    const { rawId, outcome } = await raceAgainstRawInsert(
      t,
      (c) => rawInsert(c, t, "Raw", p),
      () => call(db, ctx, createCustomer, { name: "Engine", phone: p }),
    );
    assert.equal(outcome.status, "fulfilled");
    const res = (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof createCustomer>>>).value;
    assert.equal(res.created, false);
    assert.equal(res.matchedBy, "phone");
    assert.equal(res.customer.id, rawId);
    const events = await tx(db, t, async (c) => (await c.query("select 1 from outbox_events where tenant_id = $1 and type = 'customer.created'", [t])).rows);
    assert.equal(events.length, 0, "no customer.created for a row this call did not create");
    const all = await tx(db, t, async (c) => (await c.query("select id from customers where tenant_id = $1", [t])).rows);
    assert.equal(all.length, 1);
  });

  test("the same for e-mail, compared case-insensitively", async () => {
    const t = await db.createTenant("cu-race-email");
    const ctx = makeCtx(t);
    const { rawId, outcome } = await raceAgainstRawInsert(
      t,
      (c) => rawInsert(c, t, "Raw", null, "Mixed.Case@Example.com"),
      () => call(db, ctx, createCustomer, { name: "Engine", email: "mixed.case@example.com" }),
    );
    assert.equal(outcome.status, "fulfilled");
    const res = (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof createCustomer>>>).value;
    assert.equal(res.created, false);
    assert.equal(res.matchedBy, "email");
    assert.equal(res.customer.id, rawId);
  });

  test("updateCustomer onto a phone a raw writer just took: CONFLICT naming the field and the holder, and the transaction is usable afterwards", async () => {
    const t = await db.createTenant("cu-race-update");
    const ctx = makeCtx(t);
    const mine = (await call(db, ctx, createCustomer, { name: "Mine", phone: phone(3) })).customer;
    const target = phone(4);
    const { rawId, outcome } = await raceAgainstRawInsert(
      t,
      (c) => rawInsert(c, t, "Raw", target),
      () => call(db, ctx, updateCustomer, { customerId: mine.id, phone: target }),
    );
    assert.equal(outcome.status, "rejected");
    const err = (outcome as PromiseRejectedResult).reason as AppError;
    assert.equal(err.code, "CONFLICT");
    assert.equal(err.details.field, "phone");
    assert.equal(err.details.customerId, rawId);
    assert.deepEqual(err.details.candidates, [rawId]);
    assert.ok(!/customers_active|duplicate key/.test(err.message), "no database text");
    const still = await tx(db, t, async (c) => (await c.query("select phone from customers where tenant_id = $1 and id = $2", [t, mine.id])).rows[0]);
    assert.equal((still as { phone: string }).phone, phone(3), "unchanged");
  });

  test("restoreCustomer when a raw writer takes the number first: CONFLICT with the holder as candidate; the record stays archived", async () => {
    const t = await db.createTenant("cu-race-restore");
    const ctx = makeCtx(t);
    const p = phone(5);
    const old = (await call(db, ctx, createCustomer, { name: "Old", phone: p })).customer;
    await call(db, ctx, archiveCustomer, { customerId: old.id });
    const { rawId, outcome } = await raceAgainstRawInsert(
      t,
      (c) => rawInsert(c, t, "New owner", p),
      () => call(db, ctx, restoreCustomer, { customerId: old.id }),
    );
    assert.equal(outcome.status, "rejected");
    const err = (outcome as PromiseRejectedResult).reason as AppError;
    assert.equal(err.code, "CONFLICT");
    assert.equal(err.details.field, "phone");
    assert.deepEqual(err.details.candidates, [rawId]);
    const row = await tx(db, t, async (c) => (await c.query("select archived_at from customers where tenant_id = $1 and id = $2", [t, old.id])).rows[0]);
    assert.notEqual((row as { archived_at: Date | null }).archived_at, null);
  });

  test("restoring an archived customer whose number was reused is CONFLICT (engine pre-check) and details carry the candidates, for phone and e-mail", async () => {
    const t = await db.createTenant("cu-restore-taken");
    const ctx = makeCtx(t);
    const old = (await call(db, ctx, createCustomer, { name: "Old", phone: phone(6), email: "old@example.com" })).customer;
    await call(db, ctx, archiveCustomer, { customerId: old.id });
    const byPhone = (await call(db, ctx, createCustomer, { name: "P", phone: phone(6) })).customer;
    const e1 = await rejectsWith(call(db, ctx, restoreCustomer, { customerId: old.id }), "CONFLICT");
    assert.equal(e1.details.field, "phone");
    assert.deepEqual(e1.details.candidates, [byPhone.id]);
    await call(db, ctx, archiveCustomer, { customerId: byPhone.id });
    const byEmail = (await call(db, ctx, createCustomer, { name: "E", email: "OLD@example.com" })).customer;
    const e2 = await rejectsWith(call(db, ctx, restoreCustomer, { customerId: old.id }), "CONFLICT");
    assert.equal(e2.details.field, "email");
    assert.deepEqual(e2.details.candidates, [byEmail.id]);
  });

  test("the database rejects a direct duplicate regardless of the engine, archived rows do not count, tenants are independent", async () => {
    const a = await db.createTenant("cu-db-a");
    const b = await db.createTenant("cu-db-b");
    const p = phone(7);
    await tx(db, a, (c) => rawInsert(c as never, a, "First", p, "x@example.com"));
    await assert.rejects(
      tx(db, a, (c) => rawInsert(c as never, a, "Second", p)),
      (e: { code?: string; constraint?: string }) => e.code === "23505" && e.constraint === "customers_active_phone_unique",
    );
    await assert.rejects(
      tx(db, a, (c) => rawInsert(c as never, a, "Third", null, "X@EXAMPLE.com")),
      (e: { code?: string; constraint?: string }) => e.code === "23505" && e.constraint === "customers_active_email_unique",
    );
    await tx(db, b, (c) => rawInsert(c as never, b, "Other tenant, same phone", p, "x@example.com"));
    await tx(db, a, async (c) => {
      await c.query("update customers set archived_at = now() where tenant_id = $1 and phone = $2", [a, p]);
      await rawInsert(c as never, a, "Reuse after archive", p, "x@example.com");
    });
  });

  test("a 23505 on a contact index from any engine call maps to CONFLICT with the field and no database text", () => {
    for (const [constraint, field] of [["customers_active_phone_unique", "phone"], ["customers_active_email_unique", "email"]] as const) {
      const pg = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}" Key (phone)=(+919870000001) already exists.`), { code: "23505", constraint });
      const mapped = mapPgError(pg) as AppError;
      assert.equal(mapped.code, "CONFLICT");
      assert.equal(mapped.details.field, field);
      assert.equal(mapped.details.constraint, undefined, "constraint names stay inside the engine");
      assert.ok(!mapped.message.includes("9870000001") && !mapped.message.includes("duplicate key"));
    }
    const other = mapPgError(Object.assign(new Error("dup"), { code: "23505", constraint: "catalogue_items_sku_unique" })) as AppError;
    assert.equal(other.code, "CONFLICT");
    assert.equal(other.details.field, undefined);
  });

  test("many concurrent creates (engine) and raw inserts of one phone leave exactly one active customer, and every engine call succeeds", async () => {
    const t = await db.createTenant("cu-race-many");
    const ctx = makeCtx(t);
    const p = phone(8);
    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 6; i++) jobs.push(call(db, ctx, createCustomer, { name: `E${i}`, phone: p }));
    for (let i = 0; i < 4; i++) jobs.push(tx(db, t, (c) => rawInsert(c as never, t, `R${i}`, p)).catch((e: { code?: string }) => (e.code === "23505" ? "dup" : Promise.reject(e))));
    const settled = await Promise.allSettled(jobs);
    for (const [i, s] of settled.entries()) assert.equal(s.status, "fulfilled", `job ${i}: ${s.status === "rejected" ? String(s.reason) : ""}`);
    const n = await tx(db, t, async (c) => (await c.query("select count(*) as n from customers where tenant_id = $1 and phone = $2 and archived_at is null", [t, p])).rows[0]);
    assert.equal(Number((n as { n: string }).n), 1);
  });
});
