// listOrders paging and filters, and the board by status.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { acceptOrder, cancelOrder, createOrderDraft, getOrderBoard, listOrders, placeOrder, startProcessing, recordPayment, type OrderView } from "../src/index.ts";
import { connect, ctxFor, rejectsWith, restaurantFixture, tx, type Client, type Fixture, type TestDb } from "./helpers.ts";

let db: TestDb;
let fx: Fixture;
const made: OrderView[] = [];

before(async () => {
  db = await connect();
  fx = await restaurantFixture(db);
  // 12 orders, created one after another so created_at is strictly increasing.
  for (let i = 0; i < 12; i++) {
    const channel = i % 3 === 0 ? "api" : "dashboard";
    const customerId = i % 2 === 0 ? fx.customerId : fx.otherCustomerId;
    made.push(await call((s) => createOrderDraft(s, ctxFor(fx.tenantId, { channel }), { items: [{ catalogueItemId: fx.tikka, quantity: 1 + i }], customerId })));
  }
  // statuses: 0-3 stay DRAFT; 4-6 PLACED; 7-8 ACCEPTED; 9 PROCESSING; 10 CANCELLED; 11 PLACED and paid
  for (const i of [4, 5, 6, 7, 8, 9, 10, 11]) made[i] = await call((s) => placeOrder(s, ctx(), { orderId: made[i]!.id }));
  for (const i of [7, 8, 9]) made[i] = await call((s) => acceptOrder(s, ctx(), { orderId: made[i]!.id, expectedVersion: made[i]!.version }));
  made[9] = await call((s) => startProcessing(s, ctx(), { orderId: made[9]!.id, expectedVersion: made[9]!.version }));
  made[10] = await call((s) => cancelOrder(s, ctx(), { orderId: made[10]!.id }));
  await call((s) => recordPayment(s, ctx(), { orderId: made[11]!.id, amountPaise: made[11]!.totalPaise, method: "cash" }));
});
after(async () => {
  await db.close();
});

const ctx = () => ctxFor(fx.tenantId);
const call = <T>(fn: (c: Client) => Promise<T>) => tx(db, fx.tenantId, fn);

describe("listOrders", () => {
  it("newest first, with pack labels, customer name and item counts", async () => {
    const page = await call((s) => listOrders(s, ctx(), { limit: 100 }));
    assert.equal(page.items.length, 12);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.items.map((i) => i.id), [...made].reverse().map((o) => o.id));
    const first = page.items[0]!;
    assert.equal(first.reference, made[11]!.reference);
    assert.equal(first.statusLabel, "New");
    assert.equal(first.customerName, "Bala Iyer");
    assert.equal(first.itemCount, 12);
    assert.equal(first.paymentStatus, "paid");
    assert.equal(first.totalPaise, made[11]!.totalPaise);
    assert.equal(page.items.find((i) => i.id === made[10]!.id)?.statusLabel, "Cancelled");
  });

  it("pages never skip or repeat, even when new orders arrive between pages", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call((s) => listOrders(s, ctx(), { limit: 5, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
      if (pages === 1) {
        // a new order lands after the first page: it is newer than the cursor, so it must not shift later pages
        await call((s) => createOrderDraft(s, ctx(), { items: [{ catalogueItemId: fx.papad, quantity: 1 }] }));
      }
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
    assert.deepEqual(seen, [...made].reverse().map((o) => o.id));
  });

  it("filters: status, customer, channel, payment status, reference, date range", async () => {
    const byStatus = await call((s) => listOrders(s, ctx(), { status: "PLACED", limit: 100 }));
    assert.deepEqual(byStatus.items.map((i) => i.id).sort(), [made[4], made[5], made[6], made[11]].map((o) => o!.id).sort());
    const byCustomer = await call((s) => listOrders(s, ctx(), { customerId: fx.otherCustomerId, status: "DRAFT", limit: 100 }));
    assert.deepEqual(byCustomer.items.map((i) => i.id).sort(), [made[1], made[3]].map((o) => o!.id).sort());
    const byChannel = await call((s) => listOrders(s, ctx(), { channel: "api", limit: 100 }));
    assert.ok(byChannel.items.length >= 4 && byChannel.items.every((i) => i.source === "api"));
    const unpaidPlaced = await call((s) => listOrders(s, ctx(), { status: "PLACED", paymentStatus: "unpaid", limit: 100 }));
    assert.equal(unpaidPlaced.items.length, 3);
    const byRef = await call((s) => listOrders(s, ctx(), { reference: made[3]!.reference.toLowerCase() }));
    assert.deepEqual(byRef.items.map((i) => i.id), [made[3]!.id]);
    const future = await call((s) => listOrders(s, ctx(), { from: "2099-01-01T00:00:00Z" }));
    assert.equal(future.items.length, 0);
    const past = await call((s) => listOrders(s, ctx(), { to: "2000-01-01T00:00:00Z" }));
    assert.equal(past.items.length, 0);
    const all = await call((s) => listOrders(s, ctx(), { from: "2000-01-01T00:00:00Z", to: "2099-01-01T00:00:00Z", limit: 100 }));
    assert.ok(all.items.length >= 12);
  });

  it("rejects bad filters, bad limits and a forged cursor", async () => {
    const bad = (input: unknown) => rejectsWith(() => call((s) => listOrders(s, ctx(), input as never)), "VALIDATION_FAILED");
    await bad({ status: "ARCHIVED" });
    await bad({ limit: 0 });
    await bad({ limit: 101 });
    await bad({ customerId: "x" });
    await bad({ tenantId: fx.tenantId });
    await bad({ orderBy: "total_paise" });
    await bad({ cursor: "not-base64-json" });
    await bad({ cursor: Buffer.from(JSON.stringify({ t: "2031-01-01T00:00:00.000000Z", id: "1; drop table orders" })).toString("base64url") });
    await bad({ cursor: Buffer.from(JSON.stringify({ t: "now()", id: made[0]!.id })).toString("base64url") });
  });

  it("an empty tenant gives an empty page", async () => {
    const empty = await restaurantFixture(db);
    const page = await tx(db, empty.tenantId, (s) => listOrders(s, ctxFor(empty.tenantId), {}));
    assert.deepEqual(page, { items: [], nextCursor: null });
  });
});

describe("getOrderBoard", () => {
  it("defaults to the live columns, oldest first, with true counts and pack labels", async () => {
    const board = await call((s) => getOrderBoard(s, ctx()));
    assert.deepEqual(board.map((c) => [c.status, c.label, c.count]), [
      ["PLACED", "New", 4],
      ["ACCEPTED", "Accepted", 2],
      ["PROCESSING", "Preparing", 1],
      ["READY", "Ready", 0],
    ]);
    assert.deepEqual(board[0]!.orders.map((o) => o.id), [made[4], made[5], made[6], made[11]].map((o) => o!.id));
    assert.deepEqual(board[1]!.orders.map((o) => o.id), [made[7], made[8]].map((o) => o!.id));
  });

  it("limitPerStatus trims the cards but not the count; statuses can be chosen", async () => {
    const board = await call((s) => getOrderBoard(s, ctx(), { statuses: ["PLACED", "CANCELLED", "DRAFT"], limitPerStatus: 2 }));
    assert.deepEqual(board.map((c) => [c.status, c.count, c.orders.length]), [["PLACED", 4, 2], ["CANCELLED", 1, 1], ["DRAFT", 5, 2]]);
    await rejectsWith(() => call((s) => getOrderBoard(s, ctx(), { statuses: [] })), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => getOrderBoard(s, ctx(), { statuses: ["NOPE"] } as never)), "VALIDATION_FAILED");
    await rejectsWith(() => call((s) => getOrderBoard(s, ctx(), { limitPerStatus: 1000 })), "VALIDATION_FAILED");
  });
});
