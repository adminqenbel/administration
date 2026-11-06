import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BookingStatus as B,
  ConfigPack,
  OrderStatus as O,
  bookingTransitionsWithout,
  orderTransitionsWithout,
  parsePack,
  validatePack,
  type WeeklyHours,
} from "../src/index.ts";

const closed: never[] = [];
const day = [{ start: "09:00", end: "17:00" }];
const hours: WeeklyHours = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: closed, sun: closed };

function base(): ConfigPack {
  return {
    id: "test-pack",
    version: "1.0.0",
    label: "Test",
    terminology: {
      resource: "Staff", resources: "Staff", booking: "Appointment", bookings: "Appointments",
      order: "Order", orders: "Orders", customer: "Customer", customers: "Customers",
      catalogueItem: "Service", catalogueItems: "Services",
    },
    bookingMode: "slot",
    orderMode: "none",
    resourceTypes: ["staff"],
    requiredCustomerFields: ["name", "phone"],
    bookingTransitions: { transitions: bookingTransitionsWithout(), labels: {} },
    orderTransitions: { transitions: {}, labels: {} },
    notificationTemplates: {
      booking_confirmed: { title: "Appointment confirmed", body: "Hi {{customerName}}, your appointment at {{businessName}} is on {{startsAt}}." },
    },
    aiTools: ["get_business_profile", "check_availability", "create_booking_hold", "confirm_booking", "escalate_to_human"],
    dashboard: { widgets: [{ id: "today_bookings", label: "Today" }] },
    defaults: {
      timezone: "Asia/Kolkata", hours, holdMinutes: 10, defaultDurationMinutes: 30, stepMinutes: 15, bufferMinutes: 0,
      cancellationPolicy: { cancelUntilHoursBefore: 4, lateCancellation: "flag" },
    },
  };
}

function errorsOf(mutate: (p: any) => void): string[] {
  const p = structuredClone(base()) as any;
  mutate(p);
  const r = validatePack(p);
  assert.equal(r.ok, false, "expected the pack to be rejected");
  return r.errors;
}
const has = (errors: string[], text: string) => assert.ok(errors.some((e) => e.includes(text)), `${text} not in ${JSON.stringify(errors)}`);

test("the base pack is valid", () => {
  const r = validatePack(base());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(parsePack(base()).id, "test-pack");
});

test("schema level rejections", () => {
  for (const mutate of [
    (p: any) => { p.id = "Bad Id"; },
    (p: any) => { p.version = "1"; },
    (p: any) => { p.label = ""; },
    (p: any) => { delete p.terminology.orders; },
    (p: any) => { p.terminology.extra = "x"; },
    (p: any) => { p.bookingMode = "calendar"; },
    (p: any) => { p.orderMode = "cart"; },
    (p: any) => { p.resourceTypes = ["spaceship"]; },
    (p: any) => { p.requiredCustomerFields = ["ssn"]; },
    (p: any) => { p.unknownKey = true; },
    (p: any) => { p.defaults.holdMinutes = 0; },
    (p: any) => { p.defaults.holdMinutes = 1.5; },
    (p: any) => { p.defaults.timezone = "Mars/Base"; },
    (p: any) => { p.defaults.hours.mon = [{ start: "17:00", end: "09:00" }]; },
    (p: any) => { p.defaults.cancellationPolicy.lateCancellation = "maybe"; },
    (p: any) => { p.notificationTemplates.made_up = { title: "t", body: "b" }; },
    (p: any) => { p.dashboard.widgets = [{ id: "bitcoin_price", label: "x" }]; },
  ]) {
    errorsOf(mutate);
  }
  assert.equal(validatePack(null).ok, false);
  assert.equal(validatePack("pack").ok, false);
  assert.equal(validatePack(undefined).ok, false);
});

test("extra status is rejected", () => {
  const e1 = errorsOf((p) => { p.bookingTransitions.transitions.PENDING = ["CONFIRMED"]; });
  assert.ok(e1.length > 0);
  errorsOf((p) => { p.bookingTransitions.transitions.HOLD = ["CONFIRMED", "WAITLISTED"]; });
  errorsOf((p) => { p.bookingTransitions.labels.WAITLISTED = "Waitlist"; });
  errorsOf((p) => { p.orderMode = "catalogue"; p.orderTransitions.transitions = { DRAFT: ["PLACED"], PLACED: ["SHIPPED"] }; });
});

test("bad transition is rejected: widening, missing core edge, unreachable status", () => {
  has(errorsOf((p) => { p.bookingTransitions.transitions.HOLD = ["CONFIRMED", "COMPLETED"]; }), "HOLD -> COMPLETED is not in the default machine");
  has(errorsOf((p) => { p.bookingTransitions.transitions.COMPLETED = ["CONFIRMED"]; }), "COMPLETED -> CONFIRMED");
  has(errorsOf((p) => { p.bookingTransitions.transitions = { HOLD: ["CANCELLED"] }; }), "HOLD -> CONFIRMED is required");
  has(errorsOf((p) => { p.bookingTransitions.transitions = { HOLD: ["CONFIRMED"], CHECKED_IN: ["COMPLETED"] }; }), "CHECKED_IN is not reachable");
  has(errorsOf((p) => { p.bookingTransitions.transitions.HOLD = ["CONFIRMED", "CONFIRMED"]; }), "more than once");
  has(errorsOf((p) => { p.bookingTransitions.labels.NO_SHOW = "Missed"; p.bookingTransitions.transitions = bookingTransitionsWithout([B.CONFIRMED, B.NO_SHOW]); }), "label for unused status NO_SHOW");
});

test("order transitions are checked the same way", () => {
  const withOrders = (p: any) => {
    p.orderMode = "catalogue";
    p.aiTools = ["get_business_profile", "get_catalogue", "create_order_draft", "confirm_order"];
    p.bookingMode = "none";
    p.bookingTransitions = { transitions: {}, labels: {} };
    p.resourceTypes = [];
    p.notificationTemplates = {};
    p.dashboard = { widgets: [{ id: "open_orders", label: "Open orders" }] };
  };
  const good = structuredClone(base()) as any;
  withOrders(good);
  good.orderTransitions = { transitions: orderTransitionsWithout(), labels: { PROCESSING: "Packing" } };
  assert.equal(validatePack(good).ok, true, JSON.stringify(validatePack(good).errors));
  has(errorsOf((p) => { withOrders(p); p.orderTransitions = { transitions: orderTransitionsWithout(), labels: {} }; p.orderTransitions.transitions.DRAFT = ["PLACED", "FULFILLED"]; }), "DRAFT -> FULFILLED");
  has(errorsOf((p) => { withOrders(p); p.orderTransitions = { transitions: { DRAFT: ["CANCELLED"] }, labels: {} }; }), "DRAFT -> PLACED is required");
  has(errorsOf((p) => { withOrders(p); p.orderTransitions = { transitions: { DRAFT: ["PLACED"], PLACED: ["ACCEPTED"], READY: ["FULFILLED"] }, labels: {} }; }), "READY is not reachable");
});

test("narrowed and relabelled transitions are accepted", () => {
  const p = structuredClone(base());
  p.bookingTransitions = {
    transitions: bookingTransitionsWithout([B.CONFIRMED, B.CHECKED_IN], [B.CHECKED_IN, B.COMPLETED], [B.HOLD, B.EXPIRED]),
    labels: { CONFIRMED: "Booked", NO_SHOW: "Did not come" },
  };
  const r = validatePack(p);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("unknown or inconsistent AI tools are rejected", () => {
  has(errorsOf((p) => { p.aiTools.push("execute_sql"); }), "aiTools");
  has(errorsOf((p) => { p.aiTools.push("update_any_record"); }), "aiTools");
  has(errorsOf((p) => { p.aiTools.push("check_availability"); }), "more than once");
  has(errorsOf((p) => { p.aiTools.push("create_order_draft"); }), 'create_order_draft needs an orderMode other than "none"');
  has(errorsOf((p) => { p.aiTools = ["confirm_booking"]; }), "confirm_booking needs create_booking_hold");
  has(errorsOf((p) => { p.aiTools = ["create_booking_hold"]; }), "create_booking_hold needs check_availability");
  has(errorsOf((p) => { p.bookingMode = "none"; p.bookingTransitions = { transitions: {}, labels: {} }; p.orderMode = "catalogue"; p.orderTransitions = { transitions: orderTransitionsWithout(), labels: {} }; p.resourceTypes = []; p.notificationTemplates = {}; p.dashboard = { widgets: [] }; p.aiTools = ["check_availability"]; }), 'check_availability needs a bookingMode other than "none"');
});

test("modes must agree with resource types", () => {
  has(errorsOf((p) => { p.bookingMode = "table"; }), 'bookingMode "table" needs resourceType "table"');
  has(errorsOf((p) => { p.bookingMode = "room"; }), 'bookingMode "room" needs resourceType "room"');
  has(errorsOf((p) => { p.resourceTypes = ["vehicle"]; }), 'bookingMode "slot" needs');
  has(errorsOf((p) => { p.resourceTypes = []; }), 'bookingMode "slot" needs');
  has(errorsOf((p) => { p.bookingMode = "period"; }), 'bookingMode "period" needs');
  has(errorsOf((p) => { p.orderMode = "dine_in"; p.orderTransitions = { transitions: orderTransitionsWithout(), labels: {} }; }), 'orderMode "dine_in" needs resourceType "table"');
  has(errorsOf((p) => { p.orderMode = "rental"; p.orderTransitions = { transitions: orderTransitionsWithout(), labels: {} }; }), 'orderMode "rental" needs');
  has(errorsOf((p) => { p.resourceTypes = ["staff", "staff"]; }), "more than once");
});

test("mode none means no transitions", () => {
  has(errorsOf((p) => { p.orderTransitions = { transitions: { DRAFT: ["PLACED"] }, labels: {} }; }), 'mode is "none"');
  has(errorsOf((p) => { p.orderTransitions = { transitions: {}, labels: { PROCESSING: "Busy" } }; }), 'mode is "none"');
  has(errorsOf((p) => { p.bookingMode = "none"; p.aiTools = []; p.notificationTemplates = {}; p.dashboard = { widgets: [] }; p.resourceTypes = []; }), "cannot both be");
});

test("templates: placeholders and copy rules", () => {
  has(errorsOf((p) => { p.notificationTemplates.booking_confirmed.body = "Hi {{password}}"; }), "unknown placeholder");
  has(errorsOf((p) => { p.notificationTemplates.booking_confirmed.body = "Hi {{customerName"; }), "malformed");
  has(errorsOf((p) => { p.notificationTemplates.booking_confirmed.body = "Total ₹500 due."; }), "no prices");
  has(errorsOf((p) => { p.notificationTemplates.booking_confirmed.body = "We guarantee your slot."; }), "no prices or guarantees");
  has(errorsOf((p) => { p.notificationTemplates.order_ready = { title: "Ready", body: "Your order is ready." }; }), "orders are off");
  has(errorsOf((p) => { p.notificationTemplates.booking_confirmed.body = "x".repeat(321); }), "body");
});

test("dashboard widgets match the modes", () => {
  has(errorsOf((p) => { p.dashboard.widgets = [{ id: "open_orders", label: "Orders" }]; }), "open_orders needs orders");
  has(errorsOf((p) => { p.dashboard.widgets = [{ id: "today_bookings", label: "a" }, { id: "today_bookings", label: "b" }]; }), "more than once");
});

test("a valid pack survives a JSON round trip", () => {
  const r = validatePack(JSON.parse(JSON.stringify(base())));
  assert.equal(r.ok, true);
  assert.equal(ConfigPack.safeParse(base()).success, true);
});

test("validatePack never throws on hostile input", () => {
  for (const v of [{}, [], 0, "", { id: {} }, { __proto__: { id: "x" } }, Object.create(null), { bookingTransitions: { transitions: { constructor: ["x"] }, labels: {} } }]) {
    assert.doesNotThrow(() => validatePack(v));
    assert.equal(validatePack(v).ok, false);
  }
});

test("BookingStatus and OrderStatus enums are what the packs rely on", () => {
  assert.equal(B.HOLD, "HOLD");
  assert.equal(O.PROCESSING, "PROCESSING");
});
