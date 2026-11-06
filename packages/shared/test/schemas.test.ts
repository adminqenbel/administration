import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availabilityQuerySchema,
  availabilityResponseSchema,
  bookingSchema,
  cancelBookingSchema,
  confirmBookingSchema,
  confirmOrderSchema,
  createBookingHoldSchema,
  createCustomerSchema,
  createOrderDraftSchema,
  customerSchema,
  idSchema,
  idempotencyKeySchema,
  listBookingsQuerySchema,
  missingCustomerFields,
  orderSchema,
  pageSchema,
  paginationQuerySchema,
  rescheduleBookingSchema,
  transitionBookingSchema,
  transitionOrderSchema,
  updateBookingSchema,
  updateCustomerSchema,
  updateOrderDraftSchema,
} from "../src/index.ts";

const ID = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const T0 = "2026-11-09T04:30:00.000Z";
const T1 = "2026-11-09T05:30:00.000Z";
const ok = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => assert.equal(s.safeParse(v).success, true, JSON.stringify(v));
const bad = (s: { safeParse(v: unknown): { success: boolean } }, v: unknown) => assert.equal(s.safeParse(v).success, false, JSON.stringify(v));

test("ids accept fixed seed uuids and reject junk", () => {
  ok(idSchema, ID);
  ok(idSchema, "00000000-0000-0000-0000-000000000001");
  ok(idSchema, "3f2b8c1e-5d4a-4b6e-9c7d-1a2b3c4d5e6f");
  for (const b of ["", "abc", "1", `${ID}x`, "' or 1=1 --", 5, null]) bad(idSchema, b);
});

test("idempotency key format", () => {
  ok(idempotencyKeySchema, "booking-2026-11-09-abc");
  ok(idempotencyKeySchema, "a1b2c3d4:e5");
  for (const b of ["short", "has space here", "x".repeat(129), "emoji-\u{1F600}-key", ""]) bad(idempotencyKeySchema, b);
});

test("pagination coerces query strings and bounds limit", () => {
  assert.deepEqual(paginationQuerySchema.parse({}), { limit: 25 });
  assert.deepEqual(paginationQuerySchema.parse({ limit: "50", cursor: "abc" }), { limit: 50, cursor: "abc" });
  for (const b of [{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "x" }, { cursor: "" }, { offset: 5 }]) bad(paginationQuerySchema, b);
  const page = pageSchema(idSchema);
  ok(page, { items: [ID], nextCursor: null });
  ok(page, { items: [], nextCursor: "c1" });
  bad(page, { items: ["x"], nextCursor: null });
});

test("customer create: strict, normalises phone and email", () => {
  const c = createCustomerSchema.parse({ name: "  Asha Rao ", phone: "+91 98765-43210", email: " Asha@Example.COM " });
  assert.equal(c.name, "Asha Rao");
  assert.equal(c.phone, "+919876543210");
  assert.equal(c.email, "asha@example.com");
  ok(createCustomerSchema, { name: "A", dateOfBirth: "1990-02-28" });
  for (const b of [
    {},
    { name: "" },
    { name: "   " },
    { name: "x".repeat(121) },
    { name: "A", phone: "12" },
    { name: "A", phone: "abcdefghij" },
    { name: "A", email: "not-an-email" },
    { name: "A", dateOfBirth: "1990-02-30" },
    { name: "A", dateOfBirth: "28/02/1990" },
  ]) bad(createCustomerSchema, b);
});

test("tenant_id, org_id and role are never accepted from input", () => {
  const smuggled = [{ tenantId: ID }, { tenant_id: ID }, { orgId: ID }, { org_id: ID }, { role: "OWNER" }];
  for (const extra of smuggled) {
    bad(createCustomerSchema, { name: "A", ...extra });
    bad(updateCustomerSchema, { name: "A", ...extra });
    bad(createBookingHoldSchema, { startsAt: T0, durationMinutes: 30, ...extra });
    bad(confirmBookingSchema, { customerId: ID, ...extra });
    bad(rescheduleBookingSchema, { startsAt: T0, durationMinutes: 30, expectedVersion: 1, ...extra });
    bad(cancelBookingSchema, { ...extra });
    bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1 }], ...extra });
    bad(confirmOrderSchema, { ...extra });
    bad(availabilityQuerySchema, { from: "2026-11-09", ...extra });
    bad(listBookingsQuerySchema, { ...extra });
    bad(paginationQuerySchema, { ...extra });
  }
});

test("customer update needs at least one field and allows null to clear", () => {
  bad(updateCustomerSchema, {});
  ok(updateCustomerSchema, { phone: null });
  ok(updateCustomerSchema, { name: "New Name" });
  bad(updateCustomerSchema, { name: null });
});

test("customer response", () => {
  ok(customerSchema, {
    id: ID, name: "A", phone: null, email: null, dateOfBirth: null, address: null, notes: null,
    archivedAt: null, createdAt: T0, updatedAt: T0,
  });
  bad(customerSchema, { id: ID, name: "A" });
});

test("missingCustomerFields", () => {
  assert.deepEqual(missingCustomerFields(["name", "phone"], { name: "A" }), ["phone"]);
  assert.deepEqual(missingCustomerFields(["name", "phone"], { name: " ", phone: null }), ["name", "phone"]);
  assert.deepEqual(missingCustomerFields(["name"], { name: "A", phone: "1" }), []);
  assert.deepEqual(missingCustomerFields([], {}), []);
});

test("booking hold: needs a duration source, not two", () => {
  ok(createBookingHoldSchema, { startsAt: T0, durationMinutes: 30 });
  ok(createBookingHoldSchema, { startsAt: T0, endsAt: T1, resourceId: ID, partySize: 4 });
  ok(createBookingHoldSchema, { startsAt: T0, catalogueItemId: ID });
  bad(createBookingHoldSchema, { startsAt: T0 });
  bad(createBookingHoldSchema, { startsAt: T0, endsAt: T1, durationMinutes: 60 });
  bad(createBookingHoldSchema, { startsAt: T1, endsAt: T0 });
  bad(createBookingHoldSchema, { startsAt: T0, endsAt: T0 });
  bad(createBookingHoldSchema, { startsAt: "2026-11-09", durationMinutes: 30 });
  bad(createBookingHoldSchema, { startsAt: T0, durationMinutes: 0 });
  bad(createBookingHoldSchema, { startsAt: T0, durationMinutes: 1441 });
  bad(createBookingHoldSchema, { startsAt: T0, durationMinutes: 30, partySize: 0 });
  bad(createBookingHoldSchema, { startsAt: T0, durationMinutes: 30, resourceId: "x" });
});

test("confirm booking: exactly one of customerId or customer", () => {
  ok(confirmBookingSchema, { customerId: ID });
  ok(confirmBookingSchema, { customer: { name: "A", phone: "9876543210" } });
  bad(confirmBookingSchema, {});
  bad(confirmBookingSchema, { customerId: ID, customer: { name: "A" } });
  bad(confirmBookingSchema, { customer: { name: "A", tenantId: ID } });
});

test("reschedule, cancel, transition, update", () => {
  ok(rescheduleBookingSchema, { startsAt: T0, durationMinutes: 45, expectedVersion: 2 });
  bad(rescheduleBookingSchema, { startsAt: T0, durationMinutes: 45 });
  bad(rescheduleBookingSchema, { startsAt: T0, durationMinutes: 45, expectedVersion: 0 });
  ok(cancelBookingSchema, {});
  ok(cancelBookingSchema, { reason: "Change of plan" });
  bad(cancelBookingSchema, { reason: "x".repeat(301) });
  ok(transitionBookingSchema, { to: "CHECKED_IN", expectedVersion: 1 });
  ok(transitionBookingSchema, { to: "NO_SHOW", expectedVersion: 1 });
  // CANCELLED / CONFIRMED have their own actions; free-form status is not accepted here
  bad(transitionBookingSchema, { to: "CANCELLED", expectedVersion: 1 });
  bad(transitionBookingSchema, { to: "CONFIRMED", expectedVersion: 1 });
  bad(transitionBookingSchema, { to: "BOGUS", expectedVersion: 1 });
  bad(updateBookingSchema, { status: "CONFIRMED", expectedVersion: 1 });
  ok(updateBookingSchema, { notes: null, expectedVersion: 1 });
});

test("booking response", () => {
  const b = {
    id: ID, status: "HOLD", resourceId: ID2, customerId: null, catalogueItemId: null,
    startsAt: T0, endsAt: T1, partySize: null, notes: null, holdExpiresAt: T1, source: "web_chat",
    version: 1, createdAt: T0, updatedAt: T0,
  };
  ok(bookingSchema, b);
  bad(bookingSchema, { ...b, status: "PENDING" });
  bad(bookingSchema, { ...b, source: "fax" });
});

test("order draft: items required, price never accepted", () => {
  ok(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 2, note: "No onions" }] });
  ok(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1 }], resourceId: ID2, customerId: ID });
  bad(createOrderDraftSchema, { items: [] });
  bad(createOrderDraftSchema, {});
  bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 0 }] });
  bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1.5 }] });
  bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1000 }] });
  bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1, unitPricePaise: 1 }] });
  bad(createOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1 }], totalPaise: 0 });
  bad(createOrderDraftSchema, { items: Array.from({ length: 101 }, () => ({ catalogueItemId: ID, quantity: 1 })) });
});

test("order update, confirm, transition", () => {
  ok(updateOrderDraftSchema, { items: [{ catalogueItemId: ID, quantity: 1 }], expectedVersion: 1 });
  bad(updateOrderDraftSchema, { notes: "x" });
  ok(confirmOrderSchema, {});
  ok(confirmOrderSchema, { customerId: ID });
  bad(confirmOrderSchema, { customerId: ID, customer: { name: "A" } });
  ok(transitionOrderSchema, { to: "PROCESSING", expectedVersion: 3 });
  bad(transitionOrderSchema, { to: "SHIPPED", expectedVersion: 3 });
  bad(transitionOrderSchema, { to: "READY" });
});

test("order response uses integer paise only", () => {
  const o = {
    id: ID, status: "PLACED", customerId: null, bookingId: null, resourceId: null,
    items: [{ id: ID2, catalogueItemId: ID, name: "Tea", quantity: 2, unitPricePaise: 5000, linePaise: 10_000, note: null }],
    subtotalPaise: 10_000, discountPaise: 0, taxPaise: 500, totalPaise: 10_500, currency: "INR",
    paymentStatus: "unpaid", notes: null, source: "dashboard", version: 1, createdAt: T0, updatedAt: T0,
  };
  ok(orderSchema, o);
  bad(orderSchema, { ...o, totalPaise: 105.5 });
  bad(orderSchema, { ...o, totalPaise: "105" });
  bad(orderSchema, { ...o, totalPaise: -1 });
  bad(orderSchema, { ...o, currency: "inr" });
  bad(orderSchema, { ...o, paymentStatus: "maybe" });
});

test("availability query: dates, range, limits", () => {
  ok(availabilityQuerySchema, { from: "2026-11-09" });
  ok(availabilityQuerySchema, { from: "2026-11-09", to: "2026-11-22" }); // 14 days
  ok(availabilityQuerySchema, { from: "2026-11-09", durationMinutes: "45", partySize: "2" });
  bad(availabilityQuerySchema, { from: "2026-11-09", to: "2026-11-23" }); // 15 days
  bad(availabilityQuerySchema, { from: "2026-11-09", to: "2026-11-08" });
  bad(availabilityQuerySchema, { from: "2026-02-30" });
  bad(availabilityQuerySchema, { from: "tomorrow" });
  bad(availabilityQuerySchema, {});
  bad(availabilityQuerySchema, { from: "2026-11-09", durationMinutes: "0" });
});

test("availability response", () => {
  ok(availabilityResponseSchema, { timezone: "Asia/Kolkata", slots: [{ startsAt: T0, endsAt: T1, resourceId: ID, resourceName: "Asha" }] });
  ok(availabilityResponseSchema, { timezone: "Asia/Kolkata", slots: [] });
  bad(availabilityResponseSchema, { timezone: "Asia/Kolkata", slots: [{ startsAt: T0, endsAt: T1 }] });
});

test("list filters", () => {
  ok(listBookingsQuerySchema, { status: "CONFIRMED", from: T0, to: T1, limit: "10" });
  bad(listBookingsQuerySchema, { status: "NOPE" });
  bad(listBookingsQuerySchema, { limit: "500" });
});

test("injection-shaped text stays plain text (no markup stripping or execution)", () => {
  const c = createCustomerSchema.parse({ name: "<script>alert(1)</script>", notes: "'; drop table customers; --" });
  assert.equal(c.name, "<script>alert(1)</script>"); // stored as is, escaped on output
  assert.equal(c.notes, "'; drop table customers; --");
});
