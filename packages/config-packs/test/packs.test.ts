import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  BookingStatus,
  OrderStatus,
  ToolName,
  bookingMachine,
  defineMachine,
  extraTransitions,
  generateSlots,
  orderMachine,
  validatePack,
  type ConfigPack,
} from "@qenbel/shared";
import { getPack, isPackId, listPacks, packIds } from "../src/index.ts";

const clone = (id: string) => structuredClone(getPack(id)) as any;

function reject(mutate: (p: any) => void, expect?: string, from = "salon") {
  const p = clone(from);
  mutate(p);
  const r = validatePack(p);
  assert.equal(r.ok, false, "expected rejection");
  if (expect) assert.ok(r.errors.some((e) => e.includes(expect)), `${expect} not in ${JSON.stringify(r.errors)}`);
}

test("registry lists the seven packs", () => {
  assert.deepEqual([...packIds], ["salon", "clinic", "restaurant", "retail", "hotel", "home-services", "rental"]);
  assert.deepEqual(listPacks().map((p) => p.id), [...packIds]);
  for (const id of packIds) assert.ok(isPackId(id));
  assert.equal(isPackId("spaceport"), false);
});

test("every pack validates", () => {
  for (const id of packIds) {
    const r = validatePack(getPack(id));
    assert.equal(r.ok, true, `${id}: ${JSON.stringify(r.errors)}`);
  }
});

test("pack ids are unique and match their registry key", () => {
  const ids = listPacks().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of packIds) assert.equal(getPack(id).id, id);
});

test("getPack throws NOT_FOUND for unknown ids and never for prototype keys", () => {
  for (const bad of ["nope", "", "__proto__", "constructor", "toString", "SALON"]) {
    assert.throws(() => getPack(bad), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND", bad);
  }
});

test("packs are frozen; callers cannot change shared data", () => {
  const p = getPack("salon");
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.terminology) && Object.isFrozen(p.aiTools));
  assert.throws(() => {
    (p.aiTools as string[]).push("execute_sql");
  }, TypeError);
  assert.ok(!getPack("salon").aiTools.includes("execute_sql" as never));
});

test("clinic: Doctors, Appointments, Consultation", () => {
  const p = getPack("clinic");
  assert.equal(p.terminology.resources, "Doctors");
  assert.equal(p.terminology.bookings, "Appointments");
  assert.equal(p.terminology.catalogueItem, "Consultation");
  assert.equal(p.bookingMode, "slot");
  assert.equal(p.orderMode, "none");
  assert.ok(p.resourceTypes.includes("doctor"));
  assert.deepEqual(p.requiredCustomerFields, ["name", "phone"]);
  assert.ok(!p.requiredCustomerFields.includes("dateOfBirth"));
});

test("restaurant: Tables, Reservations, Orders, Kitchen; PROCESSING reads Preparing", () => {
  const p = getPack("restaurant");
  assert.equal(p.terminology.resources, "Tables");
  assert.equal(p.terminology.bookings, "Reservations");
  assert.equal(p.terminology.orders, "Orders");
  assert.equal(p.bookingMode, "table");
  assert.equal(p.orderMode, "dine_in");
  assert.equal(p.orderTransitions.labels.PROCESSING, "Preparing");
  assert.ok(p.dashboard.widgets.some((w) => w.id === "kitchen_queue" && w.label === "Kitchen"));
  assert.ok(p.resourceTypes.includes("table"));
});

test("salon: Staff, Services, Appointments", () => {
  const p = getPack("salon");
  assert.equal(p.terminology.resources, "Staff");
  assert.equal(p.terminology.catalogueItems, "Services");
  assert.equal(p.terminology.bookings, "Appointments");
  assert.equal(p.orderMode, "none");
});

test("tool allow-lists fit each pack", () => {
  const salon = getPack("salon").aiTools;
  assert.ok(salon.includes("confirm_booking") && salon.includes("escalate_to_human"));
  assert.ok(!salon.some((t) => t.includes("order")));
  // clinic keeps patient lookup out of the AI channel
  assert.ok(!getPack("clinic").aiTools.includes("search_customer"));
  assert.ok(getPack("restaurant").aiTools.includes("create_order_draft"));
  assert.equal(getPack("restaurant").aiTools.length, Object.values(ToolName).length);
  const all = new Set<string>(Object.values(ToolName));
  for (const p of listPacks()) for (const t of p.aiTools) assert.ok(all.has(t), `${p.id}: ${t}`);
});

test("every pack's transitions only narrow the default machines", () => {
  for (const p of listPacks()) {
    if (p.bookingMode !== "none") {
      const m = defineMachine<BookingStatus>({ initial: BookingStatus.HOLD, transitions: p.bookingTransitions.transitions });
      assert.deepEqual(extraTransitions(m, bookingMachine), [], p.id);
    }
    if (p.orderMode !== "none") {
      const m = defineMachine<OrderStatus>({ initial: OrderStatus.DRAFT, transitions: p.orderTransitions.transitions });
      assert.deepEqual(extraTransitions(m, orderMachine), [], p.id);
    }
  }
});

test("copy rules: no hype, no prices, QenBel written correctly", () => {
  const hype = /\b(best|amazing|incredible|revolutionary|world-class|seamless|unleash|supercharge|cutting-edge|guarantee[ds]?)\b/i;
  const money = /₹|\bINR\b|\bRs\b\.?|\$\d/;
  const bad = /qenbel|QENBEL|Qen Bel/;
  for (const p of listPacks()) {
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") strings.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk({ label: p.label, terminology: p.terminology, notificationTemplates: p.notificationTemplates, dashboard: p.dashboard, b: p.bookingTransitions.labels, o: p.orderTransitions.labels });
    for (const s of strings) {
      assert.ok(!hype.test(s), `${p.id}: ${s}`);
      assert.ok(!money.test(s), `${p.id}: ${s}`);
      assert.ok(!/!/.test(s), `${p.id}: no exclamation marks: ${s}`);
      if (/qenbel/i.test(s)) assert.ok(!bad.test(s) || s.includes("QenBel"), `${p.id}: ${s}`);
    }
  }
});

test("notification templates are short and plain", () => {
  for (const p of listPacks()) {
    for (const [key, t] of Object.entries(p.notificationTemplates)) {
      assert.ok(t.title.length <= 40, `${p.id}.${key} title`);
      assert.ok(t.body.length <= 160, `${p.id}.${key} body`);
    }
  }
});

test("defaults are sane and drive slot generation", () => {
  for (const p of listPacks()) {
    if (p.bookingMode === "none") continue;
    const d = p.defaults;
    assert.ok(d.holdMinutes >= 1 && d.holdMinutes <= 60, `${p.id} hold`);
    // find the first open weekday and generate slots with the pack defaults
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    const open = days.find((day) => d.hours[day].length > 0);
    assert.ok(open, `${p.id} has opening hours`);
    const dateFor = { mon: "2026-11-09", tue: "2026-11-10", wed: "2026-11-11", thu: "2026-11-12", fri: "2026-11-13", sat: "2026-11-14", sun: "2026-11-15" }[open as (typeof days)[number]];
    const slots = generateSlots({
      timezone: d.timezone,
      date: dateFor,
      hours: d.hours,
      durationMinutes: d.defaultDurationMinutes,
      stepMinutes: d.stepMinutes,
      bufferMinutes: d.bufferMinutes,
    });
    assert.ok(slots.length > 0, `${p.id} yields slots`);
  }
});

test("clinic and restaurant have a midday break built into opening hours", () => {
  assert.equal(getPack("clinic").defaults.hours.mon.length, 2);
  assert.equal(getPack("restaurant").defaults.hours.sun.length, 2);
  assert.equal(getPack("salon").defaults.hours.sun.length, 0);
});

// ---- invalid packs are rejected ---------------------------------------

test("rejects a bad transition", () => {
  reject((p) => { p.bookingTransitions.transitions.COMPLETED = ["HOLD"]; }, "COMPLETED -> HOLD");
  reject((p) => { p.bookingTransitions.transitions.HOLD = ["CONFIRMED", "COMPLETED"]; }, "HOLD -> COMPLETED");
  reject((p) => { p.orderTransitions.transitions.DRAFT = ["PLACED", "FULFILLED"]; }, "DRAFT -> FULFILLED", "restaurant");
  reject((p) => { p.orderTransitions.transitions.DRAFT = []; }, "DRAFT -> PLACED is required", "restaurant");
  reject((p) => { p.orderTransitions.transitions.PLACED = ["ACCEPTED"]; p.orderTransitions.transitions.ACCEPTED = []; }, "not reachable", "restaurant");
});

test("rejects an unknown tool", () => {
  reject((p) => { p.aiTools.push("execute_sql"); });
  reject((p) => { p.aiTools.push("update_any_record"); });
  reject((p) => { p.aiTools = ["get_business_profile", "GET_CATALOGUE"]; });
  reject((p) => { p.aiTools.push("get_order_status"); }, 'needs an orderMode other than "none"');
});

test("rejects an extra status", () => {
  reject((p) => { p.bookingTransitions.transitions.PENDING = ["CONFIRMED"]; });
  reject((p) => { p.bookingTransitions.transitions.HOLD.push("WAITLISTED"); });
  reject((p) => { p.bookingTransitions.labels.WAITLISTED = "Waitlist"; });
  reject((p) => { p.orderTransitions.transitions.READY = ["FULFILLED", "SHIPPED"]; }, undefined, "restaurant");
  reject((p) => { p.orderTransitions.labels.SHIPPED = "Shipped"; }, undefined, "restaurant");
});

test("rejects modes that disagree with resource types", () => {
  reject((p) => { p.resourceTypes = ["table"]; p.bookingMode = "room"; }, 'bookingMode "room"');
  reject((p) => { p.resourceTypes = ["staff"]; }, 'bookingMode "table"', "restaurant");
  reject((p) => { p.resourceTypes = ["room"]; }, 'orderMode "dine_in"', "restaurant");
  reject((p) => { p.bookingMode = "none"; }, undefined, "salon");
});

test("rejects bad copy in templates", () => {
  reject((p) => { p.notificationTemplates.booking_confirmed.body = "Pay ₹500 now"; }, "no prices");
  reject((p) => { p.notificationTemplates.booking_confirmed.body = "Hi {{secret}}"; }, "unknown placeholder");
});

test("rejects missing or extra top-level keys", () => {
  reject((p) => { delete p.defaults; });
  reject((p) => { p.tenantId = "00000000-0000-0000-0000-000000000001"; });
  reject((p) => { delete p.terminology.resources; });
});

test("every pack survives a JSON round trip", () => {
  for (const p of listPacks()) {
    const copy = JSON.parse(JSON.stringify(p)) as ConfigPack;
    assert.equal(validatePack(copy).ok, true, p.id);
  }
});
