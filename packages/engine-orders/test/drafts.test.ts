// Drafts against the real Postgres: server-side pricing, tampering, idempotency (including concurrent duplicates),
// line edits, quantity limits, discounts and caps, fulfilment and booking links, and version conflicts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import {
  DISCOUNT_APPROVAL_CAP_BPS,
  addItem,
  applyDiscount,
  createOrderDraft,
  getOrder,
  removeDiscount,
  removeItem,
  setFulfilment,
  updateItem,
  updateOrderNotes,
  type OrderView,
} from "../src/index.ts";
import { connect, count, ctxFor, insert, rejectsWith, restaurantFixture, tx, type Client, type Fixture, type TestDb } from "./helpers.ts";

let db: TestDb;
let fx: Fixture;

before(async () => {
  db = await connect();
  fx = await restaurantFixture(db);
});
after(async () => {
  await db.close();
});

const ctx = (extra = {}) => ctxFor(fx.tenantId, extra);
const draft = (items: { catalogueItemId: string; quantity: number; variantId?: string; note?: string }[], extra: Record<string, unknown> = {}, c = ctx()) =>
  tx(db, fx.tenantId, (sql) => createOrderDraft(sql, c, { items, ...extra }));
const call = <T>(fn: (c: Client) => Promise<T>) => tx(db, fx.tenantId, fn);

describe("createOrderDraft: server-side pricing", () => {
  it("prices every line from the catalogue and snapshots name, price and tax", async () => {
    const o = await draft([
      { catalogueItemId: fx.tikka, quantity: 2 },
      { catalogueItemId: fx.soda, quantity: 1, note: "no ice" },
    ]);
    assert.equal(o.status, "DRAFT");
    assert.equal(o.version, 1);
    assert.equal(o.items.length, 2);
    assert.deepEqual(o.items.map((i) => [i.name, i.quantity, i.unitPricePaise, i.linePaise, i.taxPaise, i.note]), [
      ["Paneer tikka", 2, 10000, 20000, 1000, null],
      ["Lime soda", 1, 4950, 4950, 891, "no ice"],
    ]);
    assert.equal(o.subtotalPaise, 24950);
    assert.equal(o.taxPaise, 1891);
    assert.equal(o.discountPaise, 0);
    assert.equal(o.totalPaise, 26841);
    assert.equal(o.paymentStatus, "unpaid");
    assert.equal(o.currency, "INR");
    assert.equal(o.source, "dashboard");
    assert.match(o.reference, /^[0-9A-F]{8}$/);
    assert.equal(o.statusLabel, "Draft");
    assert.deepEqual(o.allowedNext, ["PLACED", "CANCELLED"]);
  });

  it("a later catalogue price change does not change the order (R5.2)", async () => {
    const o = await draft([{ catalogueItemId: fx.papad, quantity: 4 }]);
    await call((sql) => sql.query("update catalogue_items set base_price_paise = 99999, name = 'Renamed' where id = $1", [fx.papad]));
    const again = await call((sql) => getOrder(sql, ctx(), { orderId: o.id }));
    assert.equal(again.items[0]?.unitPricePaise, 100);
    assert.equal(again.items[0]?.name, "Papad");
    assert.equal(again.totalPaise, 400);
    await call((sql) => sql.query("update catalogue_items set base_price_paise = 100, name = 'Papad' where id = $1", [fx.papad]));
  });

  it("uses the variant's price and name", async () => {
    const o = await draft([{ catalogueItemId: fx.biryani, variantId: fx.variants.half, quantity: 1 }]);
    assert.equal(o.items[0]?.unitPricePaise, 12000);
    assert.equal(o.items[0]?.name, "Biryani - Half");
    assert.equal(o.items[0]?.variantId, fx.variants.half);
    assert.equal(o.totalPaise, 12600);
  });

  it("merges identical lines and keeps different notes apart", async () => {
    const o = await draft([
      { catalogueItemId: fx.tikka, quantity: 1 },
      { catalogueItemId: fx.tikka, quantity: 2 },
      { catalogueItemId: fx.tikka, quantity: 1, note: "extra spicy" },
    ]);
    assert.deepEqual(o.items.map((i) => [i.quantity, i.note]), [[3, null], [1, "extra spicy"]]);
  });

  it("rejects unavailable, archived, unknown and mismatched-variant items", async () => {
    const un = await rejectsWith(() => draft([{ catalogueItemId: fx.soldOut, quantity: 1 }]), "CONFLICT", "ORDER_ITEM_UNAVAILABLE");
    assert.equal(un.details.name, "Special thali");
    await rejectsWith(() => draft([{ catalogueItemId: fx.archived, quantity: 1 }]), "CONFLICT", "ORDER_ITEM_UNAVAILABLE");
    await rejectsWith(() => draft([{ catalogueItemId: randomUUID(), quantity: 1 }]), "NOT_FOUND", "CATALOGUE_ITEM_NOT_FOUND");
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, variantId: fx.variants.half, quantity: 1 }]), "NOT_FOUND", "CATALOGUE_VARIANT_NOT_FOUND");
    await call((sql) => sql.query("update catalogue_variants set active = false where id = $1", [fx.variants.full]));
    await rejectsWith(() => draft([{ catalogueItemId: fx.biryani, variantId: fx.variants.full, quantity: 1 }]), "CONFLICT", "ORDER_ITEM_UNAVAILABLE");
    await call((sql) => sql.query("update catalogue_variants set active = true where id = $1", [fx.variants.full]));
  });

  it("a failed draft leaves no order, line or key behind", async () => {
    const before = await call((sql) => count(sql, "select count(*) as n from orders where tenant_id = $1", [fx.tenantId]));
    await rejectsWith(
      () => draft([{ catalogueItemId: fx.tikka, quantity: 1 }, { catalogueItemId: fx.soldOut, quantity: 1 }], {}, ctx({ idempotencyKey: "fail-key-0001" })),
      "CONFLICT",
    );
    const after = await call((sql) => count(sql, "select count(*) as n from orders where tenant_id = $1", [fx.tenantId]));
    assert.equal(after, before);
    const keys = await call((sql) => count(sql, "select count(*) as n from idempotency_keys where key = 'fail-key-0001'"));
    assert.equal(keys, 0);
  });
});

describe("price tampering is impossible", () => {
  const base = () => ({ items: [{ catalogueItemId: fx.tikka, quantity: 1 }] });
  const bad = (input: unknown) => rejectsWith(() => call((sql) => createOrderDraft(sql, ctx(), input as never)), "VALIDATION_FAILED");

  it("rejects a price, tax, name or total on a line", async () => {
    for (const key of ["unitPricePaise", "pricePaise", "price", "amountPaise", "taxPaise", "taxRateBps", "linePaise", "name", "totalPaise", "discountPaise"]) {
      await bad({ items: [{ catalogueItemId: fx.tikka, quantity: 1, [key]: 1 }] });
    }
  });

  it("rejects a price, total, discount, status, version or tenant on the order", async () => {
    for (const key of ["totalPaise", "subtotalPaise", "taxPaise", "discountPaise", "status", "version", "paymentStatus", "tenantId", "tenant_id", "role", "reference"]) {
      await bad({ ...base(), [key]: key === "tenantId" || key === "tenant_id" ? fx.tenantId : 1 });
    }
  });

  it("rejects bad quantities and malformed ids", async () => {
    await bad({ items: [{ catalogueItemId: fx.tikka, quantity: 0 }] });
    await bad({ items: [{ catalogueItemId: fx.tikka, quantity: 1000 }] });
    await bad({ items: [{ catalogueItemId: fx.tikka, quantity: 1.5 }] });
    await bad({ items: [{ catalogueItemId: fx.tikka, quantity: -1 }] });
    await bad({ items: [{ catalogueItemId: "not-a-uuid", quantity: 1 }] });
    await bad({ items: [] });
    await bad({ items: Array.from({ length: 101 }, () => ({ catalogueItemId: fx.tikka, quantity: 1 })) });
    await bad({});
    await bad(null);
  });

  it("rejects tampering on addItem, updateItem and applyDiscount inputs as well", async () => {
    const o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    const v = o.version;
    const vf = (fn: () => Promise<unknown>) => rejectsWith(fn, "VALIDATION_FAILED");
    await vf(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: v, item: { catalogueItemId: fx.soda, quantity: 1, unitPricePaise: 1 } } as never)));
    await vf(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: v, item: { catalogueItemId: fx.soda, quantity: 1 }, tenantId: fx.tenantId } as never)));
    await vf(() => call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: v, itemId: o.items[0]!.id, quantity: 1, unitPricePaise: 1 } as never)));
    await vf(() => call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: v, itemId: o.items[0]!.id } as never)));
    await vf(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: v, kind: "fixed", amountPaise: -5 } as never)));
    await vf(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: v, kind: "percent", bps: 10001 } as never)));
    await vf(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: v, kind: "fixed", amountPaise: 1.5 } as never)));
    await vf(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: v, kind: "bogus", amountPaise: 1 } as never)));
    const unchanged = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(unchanged.version, v);
    assert.equal(unchanged.totalPaise, o.totalPaise);
  });
});

describe("createOrderDraft: idempotency", () => {
  it("same key and same input returns the same order, once", async () => {
    const key = `idem-${randomUUID()}`;
    const input = [{ catalogueItemId: fx.tikka, quantity: 2 }];
    const a = await draft(input, {}, ctx({ idempotencyKey: key }));
    const b = await draft(input, {}, ctx({ idempotencyKey: key }));
    assert.equal(a.id, b.id);
    assert.equal(a.reference, b.reference);
    const n = await call((sql) => count(sql, "select count(*) as n from orders where tenant_id = $1 and id = $2", [fx.tenantId, a.id]));
    assert.equal(n, 1);
  });

  it("field order in the input does not matter", async () => {
    const key = `idem-${randomUUID()}`;
    const a = await tx(db, fx.tenantId, (s) => createOrderDraft(s, ctx({ idempotencyKey: key }), { items: [{ catalogueItemId: fx.tikka, quantity: 1 }], notes: "hello", customerId: fx.customerId }));
    const b = await tx(db, fx.tenantId, (s) => createOrderDraft(s, ctx({ idempotencyKey: key }), { customerId: fx.customerId, notes: "hello", items: [{ quantity: 1, catalogueItemId: fx.tikka }] }));
    assert.equal(a.id, b.id);
  });

  it("same key with different input is IDEMPOTENCY_CONFLICT and creates nothing", async () => {
    const key = `idem-${randomUUID()}`;
    const a = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], {}, ctx({ idempotencyKey: key }));
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 2 }], {}, ctx({ idempotencyKey: key })), "IDEMPOTENCY_CONFLICT");
    const same = await call((s) => getOrder(s, ctx(), { orderId: a.id }));
    assert.equal(same.items[0]?.quantity, 1);
  });

  it("different keys make different orders; no key makes a new order each time", async () => {
    const a = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], {}, ctx({ idempotencyKey: `idem-${randomUUID()}` }));
    const b = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], {}, ctx({ idempotencyKey: `idem-${randomUUID()}` }));
    const c = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    const d = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4);
  });

  it("20 concurrent duplicates with one key create exactly one order", async () => {
    const key = `race-${randomUUID()}`;
    const input = [{ catalogueItemId: fx.tikka, quantity: 3 }, { catalogueItemId: fx.soda, quantity: 1 }];
    const results = await Promise.all(Array.from({ length: 20 }, () => draft(input, {}, ctx({ idempotencyKey: key }))));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    const n = await call((sql) => count(sql, "select count(*) as n from idempotency_keys where tenant_id = $1 and key = $2", [fx.tenantId, key]));
    assert.equal(n, 1);
    const items = await call((sql) => count(sql, "select count(*) as n from order_items where tenant_id = $1 and order_id = $2", [fx.tenantId, results[0]!.id]));
    assert.equal(items, 2);
  });

  it("concurrent duplicates with different bodies: one wins, the rest conflict, nothing duplicates", async () => {
    const key = `race-${randomUUID()}`;
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => draft([{ catalogueItemId: fx.tikka, quantity: 1 + (i % 2) }], {}, ctx({ idempotencyKey: key }))),
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<OrderView>[];
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 5, "the five callers with the winner's body replay it");
    assert.equal(new Set(ok.map((o) => o.value.id)).size, 1);
    for (const f of failed) assert.equal((f.reason as { code?: string }).code, "IDEMPOTENCY_CONFLICT");
  });

  it("a rejected key short enough to be invalid is refused", async () => {
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], {}, ctx({ idempotencyKey: "short" })), "VALIDATION_FAILED");
  });

  it("the same key in two tenants is two separate keys", async () => {
    const other = await restaurantFixture(db);
    const key = `shared-${randomUUID()}`;
    const a = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], {}, ctx({ idempotencyKey: key }));
    const b = await tx(db, other.tenantId, (s) => createOrderDraft(s, ctxFor(other.tenantId, { idempotencyKey: key }), { items: [{ catalogueItemId: other.tikka, quantity: 1 }] }));
    assert.notEqual(a.id, b.id);
  });
});

describe("line edits (draft only)", () => {
  it("addItem, updateItem and removeItem reprice and bump the version once each", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    assert.equal(o.version, 1);
    o = await call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: 1, item: { catalogueItemId: fx.soda, quantity: 2 } }));
    assert.equal(o.version, 2);
    assert.equal(o.items.length, 2);
    assert.equal(o.subtotalPaise, 10000 + 9900);
    assert.equal(o.taxPaise, 500 + Math.round(9900 * 0.18));
    o = await call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: 2, itemId: o.items[1]!.id, quantity: 5, note: "less sweet" }));
    assert.equal(o.version, 3);
    assert.equal(o.items[1]?.quantity, 5);
    assert.equal(o.items[1]?.note, "less sweet");
    assert.equal(o.items[1]?.unitPricePaise, 4950, "unit price stays the snapshot");
    assert.equal(o.subtotalPaise, 10000 + 24750);
    o = await call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: 3, itemId: o.items[0]!.id }));
    assert.equal(o.version, 4);
    assert.equal(o.items.length, 1);
    assert.equal(o.totalPaise, 24750 + 4455);
    o = await call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: 4, itemId: o.items[0]!.id, note: null }));
    assert.equal(o.items[0]?.note, null);
  });

  it("adding the same item again merges into one line", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 2 }]);
    o = await call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, item: { catalogueItemId: fx.tikka, quantity: 3 } }));
    assert.equal(o.items.length, 1);
    assert.equal(o.items[0]?.quantity, 5);
    assert.equal(o.subtotalPaise, 50000);
  });

  it("quantity limit: 999 per line, 100 lines", async () => {
    let o = await draft([{ catalogueItemId: fx.papad, quantity: 998 }]);
    await rejectsWith(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, item: { catalogueItemId: fx.papad, quantity: 2 } })), "VALIDATION_FAILED", "QUANTITY_LIMIT");
    o = await call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, item: { catalogueItemId: fx.papad, quantity: 1 } }));
    assert.equal(o.items[0]?.quantity, 999);
    await rejectsWith(() => call((s) => updateItem(s, ctx(), { orderId: o.id, expectedVersion: o.version, itemId: o.items[0]!.id, quantity: 1000 })), "VALIDATION_FAILED");
    await rejectsWith(
      () => draft([{ catalogueItemId: fx.papad, quantity: 999 }, { catalogueItemId: fx.papad, quantity: 1 }]),
      "VALIDATION_FAILED",
      "QUANTITY_LIMIT",
    );
  });

  it("a stale version changes nothing", async () => {
    const o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    const e = await rejectsWith(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: 7, item: { catalogueItemId: fx.soda, quantity: 1 } })), "VERSION_CONFLICT", "ORDER_VERSION_CONFLICT");
    assert.equal(e.details.currentVersion, 1);
    const same = await call((s) => getOrder(s, ctx(), { orderId: o.id }));
    assert.equal(same.version, 1);
    assert.equal(same.items.length, 1);
  });

  it("an item that went unavailable cannot be added; a missing line is NOT_FOUND", async () => {
    const o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    await rejectsWith(() => call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: 1, item: { catalogueItemId: fx.soldOut, quantity: 1 } })), "CONFLICT", "ORDER_ITEM_UNAVAILABLE");
    await rejectsWith(() => call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: 1, itemId: randomUUID() })), "NOT_FOUND", "ORDER_ITEM_NOT_FOUND");
  });

  it("notes update (draft only) and clear", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { notes: "first" });
    assert.equal(o.notes, "first");
    o = await call((s) => updateOrderNotes(s, ctx(), { orderId: o.id, expectedVersion: 1, notes: "second" }));
    assert.equal(o.notes, "second");
    o = await call((s) => updateOrderNotes(s, ctx(), { orderId: o.id, expectedVersion: 2, notes: null }));
    assert.equal(o.notes, null);
    assert.equal(o.version, 3);
  });
});

describe("discounts", () => {
  const audits = (orderId: string) =>
    call((sql) => sql.query<{ details: Record<string, unknown> }>("select details from audit_log where tenant_id = $1 and entity_id = $2 and action = 'order.discount_applied' order by seq", [fx.tenantId, orderId]));

  it("fixed discount reduces the taxable value; tax follows", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 2 }]); // 20000 + 1000 tax
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "fixed", amountPaise: 2000, reason: "regular" }));
    assert.equal(o.discountPaise, 2000);
    assert.equal(o.subtotalPaise, 20000);
    assert.equal(o.taxPaise, 900); // 5% of 18000
    assert.equal(o.totalPaise, 20000 - 2000 + 900);
    assert.equal(o.items[0]?.taxPaise, 900);
    assert.equal(o.version, 2);
  });

  it("percent discount is rounded with the explicit mode and replaces an earlier discount", async () => {
    let o = await draft([{ catalogueItemId: fx.soda, quantity: 1 }]); // 4950
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "percent", bps: 1000 })); // 495
    assert.equal(o.discountPaise, 495);
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 2, kind: "percent", bps: 500 })); // 247.5 -> 248
    assert.equal(o.discountPaise, 248);
    assert.equal(o.totalPaise, o.subtotalPaise - o.discountPaise + o.taxPaise);
  });

  it("never more than the subtotal", async () => {
    const o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    await rejectsWith(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "fixed", amountPaise: 10001, capOverride: true })), "VALIDATION_FAILED", "AMOUNT_INVALID");
  });

  it("above the cap needs the override flag, and the flag is recorded", async () => {
    assert.equal(DISCOUNT_APPROVAL_CAP_BPS, 2000);
    const o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    const e = await rejectsWith(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "percent", bps: 2001 })), "FORBIDDEN", "DISCOUNT_CAP_EXCEEDED");
    assert.equal(e.details.capBps, 2000);
    await rejectsWith(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "fixed", amountPaise: 2001, capOverride: false })), "FORBIDDEN", "DISCOUNT_CAP_EXCEEDED");
    // exactly at the cap needs no override
    const atCap = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "percent", bps: 2000 }));
    assert.equal(atCap.discountPaise, 2000);
    const over = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 2, kind: "percent", bps: 5000, capOverride: true, reason: "manager approved" }));
    assert.equal(over.discountPaise, 5000);
    const rows = (await audits(o.id)).rows.map((r) => r.details);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.capOverrideFlag, false);
    assert.equal(rows[0]?.capOverrideNeeded, false);
    assert.equal(rows[1]?.capOverrideFlag, true);
    assert.equal(rows[1]?.capOverrideNeeded, true);
    assert.equal(rows[1]?.reason, "manager approved");
    assert.equal(rows[1]?.discountPaise, 5000);
    assert.equal(rows[1]?.rounding, "HALF_UP");
  });

  it("an empty draft cannot be discounted; a line change clears the discount and says so", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "fixed", amountPaise: 1000 }));
    o = await call((s) => addItem(s, ctx(), { orderId: o.id, expectedVersion: 2, item: { catalogueItemId: fx.soda, quantity: 1 } }));
    assert.equal(o.discountPaise, 0);
    assert.deepEqual(o.notices, ["DISCOUNT_CLEARED"]);
    o = await call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: 3, itemId: o.items[0]!.id }));
    o = await call((s) => removeItem(s, ctx(), { orderId: o.id, expectedVersion: 4, itemId: o.items[0]!.id }));
    assert.equal(o.items.length, 0);
    assert.equal(o.totalPaise, 0);
    await rejectsWith(() => call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 5, kind: "fixed", amountPaise: 0 })), "VALIDATION_FAILED", "ORDER_EMPTY");
  });

  it("removeDiscount restores the total; removing nothing is a no-op", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    const full = o.totalPaise;
    o = await call((s) => applyDiscount(s, ctx(), { orderId: o.id, expectedVersion: 1, kind: "percent", bps: 1000 }));
    assert.ok(o.totalPaise < full);
    o = await call((s) => removeDiscount(s, ctx(), { orderId: o.id, expectedVersion: 2 }));
    assert.equal(o.totalPaise, full);
    assert.equal(o.version, 3);
    const same = await call((s) => removeDiscount(s, ctx(), { orderId: o.id, expectedVersion: 3 }));
    assert.equal(same.version, 3);
  });

  it("the stored totals satisfy the database CHECKs for every case above (spot check across the tenant)", async () => {
    const res = await call((sql) => sql.query("select count(*)::int as bad from orders where tenant_id = $1 and total_paise <> subtotal_paise + tax_paise - discount_paise", [fx.tenantId]));
    assert.equal(res.rows[0]?.bad, 0);
    const lines = await call((sql) => sql.query("select count(*)::int as bad from orders o where o.tenant_id = $1 and o.tax_paise <> (select coalesce(sum(i.tax_paise), 0) from order_items i where i.order_id = o.id)", [fx.tenantId]));
    assert.equal(lines.rows[0]?.bad, 0, "order tax equals the sum of line tax");
  });
});

describe("fulfilment and booking link", () => {
  it("delivery needs an address; pickup and on_site need nothing", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }]);
    await rejectsWith(() => call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 1, fulfilment: { type: "delivery" } as never })), "VALIDATION_FAILED");
    o = await call((s) =>
      setFulfilment(s, ctx(), {
        orderId: o.id,
        expectedVersion: 1,
        fulfilment: { type: "delivery", address: { line1: "12 Example Road", city: "Sample City", postalCode: "560001" }, scheduledFor: "2031-02-01T12:00:00Z" },
      }),
    );
    assert.equal(o.fulfilment?.type, "delivery");
    assert.equal(o.fulfilment?.status, "scheduled");
    assert.equal((o.fulfilment?.address as { city: string }).city, "Sample City");
    assert.equal(o.version, 2);
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 2, fulfilment: { type: "pickup" } }));
    assert.equal(o.fulfilment?.type, "pickup");
    assert.equal(o.fulfilment?.address, null);
    assert.equal(o.fulfilment?.status, "pending");
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 3, fulfilment: { type: "on_site", place: "Room 12" } }));
    assert.deepEqual(o.fulfilment?.address, { place: "Room 12" });
    const n = await call((sql) => count(sql, "select count(*) as n from fulfilments where tenant_id = $1 and order_id = $2", [fx.tenantId, o.id]));
    assert.equal(n, 1, "one fulfilment per order");
  });

  it("dine-in takes a table resource or a label, and createOrderDraft's resourceId implies dine-in", async () => {
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { resourceId: fx.tableId });
    assert.equal(o.fulfilment?.type, "dine_in");
    assert.equal(o.fulfilment?.tableLabel, "Table 6");
    assert.equal(o.resourceId, fx.tableId);
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 1, fulfilment: { type: "dine_in", tableLabel: "Patio 2" } }));
    assert.equal(o.fulfilment?.tableLabel, "Patio 2");
    assert.equal(o.resourceId, null);
    await rejectsWith(() => call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 2, fulfilment: { type: "dine_in" } })), "REQUIRED_FIELDS_MISSING", "TABLE_REQUIRED");
    // a resource that is not a table
    const staffId = await call((sql) => insert(sql, "resources", { tenant_id: fx.tenantId, type: "staff", name: "Chef" }));
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { resourceId: staffId }), "VALIDATION_FAILED", "RESOURCE_NOT_A_TABLE");
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { resourceId: randomUUID() }), "NOT_FOUND", "RESOURCE_NOT_FOUND");
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { resourceId: fx.tableId, fulfilment: { type: "pickup" } }), "VALIDATION_FAILED", "TABLE_CONFLICT");
  });

  it("links to a booking of the same tenant; the booking and the order stay separate records", async () => {
    const bookingId = await call((sql) =>
      insert(sql, "bookings", {
        tenant_id: fx.tenantId, location_id: fx.locationId, customer_id: fx.customerId, status: "CONFIRMED", source_channel: "api",
        starts_at: new Date("2031-03-01T13:00:00Z"), ends_at: new Date("2031-03-01T14:30:00Z"),
      }),
    );
    let o = await draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { bookingId, customerId: fx.customerId });
    assert.equal(o.bookingId, bookingId);
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 1, fulfilment: { type: "dine_in", tableLabel: "6" }, bookingId: null }));
    assert.equal(o.bookingId, null);
    o = await call((s) => setFulfilment(s, ctx(), { orderId: o.id, expectedVersion: 2, fulfilment: { type: "dine_in", tableLabel: "6" }, bookingId }));
    assert.equal(o.bookingId, bookingId);
    const bookingStillThere = await call((sql) => sql.query("select status, version from bookings where id = $1", [bookingId]));
    assert.deepEqual(bookingStillThere.rows[0], { status: "CONFIRMED", version: 1 }, "the booking is untouched");
    // booking belongs to someone else
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { bookingId, customerId: fx.otherCustomerId }), "CONFLICT", "BOOKING_CUSTOMER_MISMATCH");
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { bookingId: randomUUID() }), "NOT_FOUND", "BOOKING_NOT_FOUND");
  });

  it("unknown customers are rejected", async () => {
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { customerId: randomUUID() }), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
    await call((sql) => sql.query("update customers set archived_at = now() where id = $1", [fx.otherCustomerId]));
    await rejectsWith(() => draft([{ catalogueItemId: fx.tikka, quantity: 1 }], { customerId: fx.otherCustomerId }), "NOT_FOUND", "CUSTOMER_NOT_FOUND");
    await call((sql) => sql.query("update customers set archived_at = null where id = $1", [fx.otherCustomerId]));
  });
});

describe("pack gate", () => {
  it("a tenant whose pack takes no orders cannot create one; a tenant with no pack cannot either", async () => {
    const salon = await restaurantFixture(db, "salon");
    await rejectsWith(() => tx(db, salon.tenantId, (s) => createOrderDraft(s, ctxFor(salon.tenantId), { items: [{ catalogueItemId: salon.tikka, quantity: 1 }] })), "CONFLICT", "ORDER_MODE_NOT_SUPPORTED");
    const none = await restaurantFixture(db, null);
    await rejectsWith(() => tx(db, none.tenantId, (s) => createOrderDraft(s, ctxFor(none.tenantId), { items: [{ catalogueItemId: none.tikka, quantity: 1 }] })), "CONFLICT", "PACK_REQUIRED");
  });

  it("a retail-style catalogue pack works too, with its own labels", async () => {
    const retail = await restaurantFixture(db, "retail");
    const o = await tx(db, retail.tenantId, (s) => createOrderDraft(s, ctxFor(retail.tenantId), { items: [{ catalogueItemId: retail.tikka, quantity: 1 }] }));
    assert.equal(o.status, "DRAFT");
  });
});
