// checkAvailability: hours, schedules, holidays, breaks, time off, lead time, eligibility, DST, privacy, isolation.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { ErrorCode, type AvailabilityResponse } from "@qenbel/shared";
import {
  checkAvailability,
  confirmBooking,
  createHold,
  effectiveIntervals,
  peakUnits,
  slotsForResource,
  type ResourceAvailabilityInputs,
} from "../src/index.ts";
import { intersectIntervals, normaliseIntervals } from "../src/availability-core.ts";
import { at, atDate, connect, ctxFor, customerCtx, expectAppError, insert, MONDAY, seedSalon, tx, type Env } from "./helpers.ts";

let env: Env;
before(async () => {
  env = await connect();
});
after(async () => {
  await env.close();
});

const query = (s: { serviceId: string }, extra: Record<string, unknown> = {}) => ({ from: MONDAY, catalogueItemId: s.serviceId, ...extra });
const starts = (r: { slots: { startsAt: string }[] }) => r.slots.map((x) => x.startsAt);

describe("slots from the real tables", () => {
  test("opening hours 10-20, 60 minute service, 15 minute step: 37 slots per resource, sorted, with names", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.equal(r.timezone, "Asia/Kolkata");
    assert.equal(r.slots.length, 74);
    assert.equal(r.resources.length, 2);
    assert.deepEqual(r.resources.map((x) => x.resourceName), ["Staff A", "Staff B"]);
    assert.equal(r.resources[0]?.slots.length, 37);
    assert.equal(r.slots[0]?.startsAt, at(0));
    assert.equal(r.slots.at(-1)?.endsAt, at(10 * 60));
    const sorted = [...r.slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    assert.deepEqual(r.slots.map((x) => x.startsAt), sorted.map((x) => x.startsAt));
    // The wire shape is the shared AvailabilityResponse (extra fields are additive).
    const shape: AvailabilityResponse = { timezone: r.timezone, slots: r.slots };
    assert.ok(shape.slots.every((x) => Object.keys(x).sort().join() === "endsAt,resourceId,resourceName,startsAt"));
  });

  test("a closed weekday has no slots; a range covers several days", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const sunday = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { from: "2031-01-05" })));
    assert.equal(sunday.slots.length, 0);
    const week = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { from: "2031-01-05", to: "2031-01-11" })));
    assert.equal(week.slots.length, 6 * 37);
  });

  test("the resource's own schedule narrows the location's hours", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await insert(c, "resource_schedules", { tenant_id: s.tenantId, resource_id: s.resourceIds[0], weekday: 1, start_time: "12:00", end_time: "16:00" });
    });
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    const a = r.resources.find((x) => x.resourceId === s.resourceIds[0]);
    assert.equal(a?.slots[0]?.startsAt, at(120));
    assert.equal(a?.slots.at(-1)?.endsAt, at(6 * 60));
    assert.equal(a?.slots.length, 13); // 12:00 .. 15:00 starts
    // A resource with a schedule but nothing on a weekday is off that day (Tuesday).
    const tue = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { from: "2031-01-07", resourceId: s.resourceIds[0] })));
    assert.equal(tue.slots.length, 0);
    const b = r.resources.find((x) => x.resourceId === s.resourceIds[1]);
    assert.equal(b?.slots.length, 37, "the other resource follows the location");
  });

  test("schedule validity dates are respected", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) =>
      insert(c, "resource_schedules", { tenant_id: s.tenantId, resource_id: s.resourceIds[0], weekday: 1, start_time: "10:00", end_time: "14:00", valid_to: "2031-01-05" }),
    );
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.equal(r.slots.length, 0, "the only schedule row ended before this Monday");
  });

  test("breaks, time off, closed holidays and special-hours holidays", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await c.query("update resources set attributes = $2::jsonb where id = $1", [
        s.resourceIds[0],
        JSON.stringify({ breaks: [{ start: "13:00", end: "14:00" }], timeOff: [{ start: at(5 * 60), end: at(6 * 60) }] }),
      ]);
      await insert(c, "holidays", { tenant_id: s.tenantId, location_id: s.locationId, holiday_date: "2031-01-07", name: "Closed" });
      await insert(c, "holidays", { tenant_id: s.tenantId, location_id: null, holiday_date: "2031-01-08", name: "Short day", closed: false, open_time: "12:00", close_time: "14:00" });
    });
    const mon = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    const t = starts(mon);
    // Break 13:00-14:00: a slot must end by 13:00 or start at 14:00.
    assert.ok(t.includes(at(120)), "12:00-13:00 ends as the break starts");
    assert.ok(!t.includes(at(135)) && !t.includes(at(165)) && !t.includes(at(225)), "12:15, 12:45 and 13:45 run into the break");
    assert.ok(t.includes(at(240)), "14:00 is fine");
    // Time off 15:00-16:00: 14:00-15:00 fits, 14:15 to 15:45 do not, 16:00 is fine.
    assert.ok(t.includes(at(240)) && !t.includes(at(255)) && !t.includes(at(300)) && !t.includes(at(345)) && t.includes(at(360)));
    const tue = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { from: "2031-01-07" })));
    assert.equal(tue.slots.length, 0);
    const wed = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { from: "2031-01-08" })));
    assert.equal(wed.slots.length, 1, "special hours 12:00-14:00, minus the 13:00-14:00 break: only 12:00-13:00 is left");
  });

  test("unreadable time-off data fails closed: the resource is not offered", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => c.query("update resources set attributes = $2::jsonb where id = $1", [s.resourceIds[0], JSON.stringify({ timeOff: "next week" })]));
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.equal(r.resources.find((x) => x.resourceId === s.resourceIds[0])?.slots.length, 0);
    assert.equal(r.resources.find((x) => x.resourceId === s.resourceIds[1])?.slots.length, 37);
  });

  test("falls back to the pack's hours when the location has none configured", async () => {
    const s = await seedSalon(env, { resources: 1, openWeekdays: [] });
    const ctx = ctxFor(s.tenantId);
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.equal(r.slots.length, 37, "salon pack: Monday 10:00 to 20:00");
  });

  test("existing bookings and the cleanup buffer remove slots", async () => {
    const s = await seedSalon(env, { resources: 1, bufferMinutes: 15 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, (c) => createHold(c, ctx, { startsAt: at(120), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] })); // 12:00-13:00 (+15)
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    const t = starts(r);
    assert.ok(t.includes(at(45)), "10:45-11:45 then 15 minutes clear before 12:00");
    assert.ok(!t.includes(at(60)), "11:00-12:00 would run into the cleanup before the 12:00 booking");
    assert.ok(!t.includes(at(120)) && !t.includes(at(180)));
    assert.ok(t.includes(at(195)), "13:15 is the first start after the cleanup");
  });

  test("lead time and maximum advance hide slots from customer channels only", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await tx(env, ctxFor(s.tenantId), (c) =>
      c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { leadTimeMinutes: 120, maxAdvanceDays: 2 } })]),
    );
    const nowMorning = atDate(-30); // 09:30 Monday
    const customer = customerCtx(s.tenantId, { now: nowMorning });
    const staff = ctxFor(s.tenantId, { now: nowMorning });
    const forCustomer = await tx(env, customer, (c) => checkAvailability(c, customer, query(s)));
    assert.equal(forCustomer.slots[0]?.startsAt, at(90), "09:30 plus 2 hours is 11:30, on the 15 minute grid");
    const forStaff = await tx(env, staff, (c) => checkAvailability(c, staff, query(s)));
    assert.equal(forStaff.slots[0]?.startsAt, at(0), "staff are not held to lead time (only to the past)");
  });

  test("a customer channel sees nothing beyond maxAdvanceDays", async () => {
    const s = await seedSalon(env, { resources: 1 });
    await tx(env, ctxFor(s.tenantId), (c) =>
      c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { maxAdvanceDays: 2 } })]),
    );
    const now = atDate(-24 * 60 * 3); // Friday 2031-01-03 10:00 local
    const customer = customerCtx(s.tenantId, { now });
    const staff = ctxFor(s.tenantId, { now });
    const week = { from: "2031-01-03", to: "2031-01-08", catalogueItemId: s.serviceId };
    const cs = await tx(env, customer, (c) => checkAvailability(c, customer, week));
    const dates = new Set(cs.slots.map((x) => x.startsAt.slice(0, 10)));
    assert.deepEqual([...dates].sort(), ["2031-01-03", "2031-01-04"], "Fri and Sat only (Sunday is closed; Monday is beyond 2 days)");
    const ss = await tx(env, staff, (c) => checkAvailability(c, staff, week));
    assert.ok(ss.slots.some((x) => x.startsAt.startsWith("2031-01-06")), "staff are not limited");
  });
});

describe("eligibility", () => {
  test("a resource that lists services is offered only for those services", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    const other = await tx(env, ctx, (c) => insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "service", name: "Colour", base_price_paise: 90000, duration_minutes: 120 }));
    await tx(env, ctx, (c) => c.query("update resources set attributes = $2::jsonb where id = $1", [s.resourceIds[0], JSON.stringify({ serviceIds: [other] })]));
    const haircut = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.deepEqual(haircut.resources.map((r) => r.resourceId), [s.resourceIds[1]]);
    const colour = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: other }));
    assert.equal(colour.resources.length, 2);
    assert.equal(colour.slots[0]?.endsAt, at(120), "120 minute service");
  });

  test("a service that needs a resource type is not offered on other types; types the pack does not allow are ignored", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    const needsRoom = await tx(env, ctx, (c) =>
      insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "service", name: "Facial", base_price_paise: 1, duration_minutes: 30, required_resource_type: "room" }),
    );
    await tx(env, ctx, (c) => insert(c, "resources", { tenant_id: s.tenantId, location_id: s.locationId, type: "room", name: "Room 1" }));
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: needsRoom }));
    assert.equal(r.slots.length, 0, "salon pack only allows staff resources; the room is ignored and staff do not qualify");
  });

  test("archived and inactive resources are never offered", async () => {
    const s = await seedSalon(env, { resources: 2 });
    const ctx = ctxFor(s.tenantId);
    await tx(env, ctx, async (c) => {
      await c.query("update resources set archived_at = now() where id = $1", [s.resourceIds[0]]);
    });
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, query(s)));
    assert.deepEqual(r.resources.map((x) => x.resourceId), [s.resourceIds[1]]);
    await expectAppError(tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, { resourceId: s.resourceIds[0] }))), ErrorCode.NOT_FOUND);
  });

  test("an unknown service is NOT_FOUND; a product cannot be booked", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    await expectAppError(tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: "00000000-0000-4000-8000-0000000000aa" })), ErrorCode.NOT_FOUND);
    const product = await tx(env, ctx, (c) => insert(c, "catalogue_items", { tenant_id: s.tenantId, kind: "product", name: "Shampoo", base_price_paise: 1 }));
    await expectAppError(tx(env, ctx, (c) => checkAvailability(c, ctx, { from: MONDAY, catalogueItemId: product })), ErrorCode.VALIDATION_FAILED);
  });
});

describe("privacy and isolation", () => {
  test("the answer carries times and resource names only: nothing about who holds the other slots", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const staff = ctxFor(s.tenantId);
    const h = await tx(env, staff, (c) => createHold(c, staff, { startsAt: at(0), catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] }));
    await tx(env, staff, (c) => confirmBooking(c, staff, { bookingId: h.booking.id, customerId: s.customerId }));
    const customer = customerCtx(s.tenantId, { now: atDate(-24 * 60) });
    const r = await tx(env, customer, (c) => checkAvailability(c, customer, query(s)));
    const text = JSON.stringify(r);
    for (const secret of [h.booking.id, h.booking.reference, s.customerId, "Asha"]) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.ok(!starts(r).includes(at(0)), "but the booked slot is gone");
  });

  test("another tenant's resource id is NOT_FOUND and its data never shows up", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const ctxA = ctxFor(a.tenantId);
    await expectAppError(tx(env, ctxA, (c) => checkAvailability(c, ctxA, query(a, { resourceId: b.resourceIds[0] }))), ErrorCode.NOT_FOUND);
    const ctxB = ctxFor(b.tenantId);
    await tx(env, ctxB, (c) => createHold(c, ctxB, { startsAt: at(0), catalogueItemId: b.serviceId, resourceId: b.resourceIds[0] }));
    const r = await tx(env, ctxA, (c) => checkAvailability(c, ctxA, query(a)));
    assert.ok(starts(r).includes(at(0)), "tenant B's booking does not block tenant A");
    assert.deepEqual(r.resources.map((x) => x.resourceId), a.resourceIds);
  });

  test("input is strict: tenantId, role and unknown keys are VALIDATION_FAILED", async () => {
    const s = await seedSalon(env, { resources: 1 });
    const ctx = ctxFor(s.tenantId);
    for (const extra of [{ tenantId: s.tenantId }, { tenant_id: s.tenantId }, { role: "OWNER" }, { surprise: 1 }]) {
      await expectAppError(tx(env, ctx, (c) => checkAvailability(c, ctx, query(s, extra))), ErrorCode.VALIDATION_FAILED);
    }
    await expectAppError(tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-01-06", to: "2031-03-01" })), ErrorCode.VALIDATION_FAILED);
  });

  test("a context for one tenant on a connection scoped to another is refused", async () => {
    const a = await seedSalon(env, { resources: 1 });
    const b = await seedSalon(env, { resources: 1 });
    const wrong = ctxFor(b.tenantId);
    await expectAppError(tx(env, ctxFor(a.tenantId), (c) => checkAvailability(c, wrong, query(b))), ErrorCode.TENANT_REQUIRED);
  });
});

describe("daylight saving time", () => {
  async function dstTenant(timezone: string, weekday: number) {
    const s = await seedSalon(env, { timezone, resources: 1, openWeekdays: [] });
    const ctx = ctxFor(s.tenantId, { now: new Date("2031-01-15T00:00:00Z") });
    await tx(env, ctx, async (c) => {
      await insert(c, "business_hours", { tenant_id: s.tenantId, location_id: s.locationId, weekday, open_time: "00:00", close_time: "06:00" });
      await c.query("update tenants set settings = $2::jsonb where id = $1", [s.tenantId, JSON.stringify({ bookings: { stepMinutes: 60 } })]);
    });
    return { s, ctx };
  }

  test("spring forward (America/New_York, 2031-03-09): the 00:00-06:00 window is five real hours", async () => {
    const { s, ctx } = await dstTenant("America/New_York", 0);
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-03-09", catalogueItemId: s.serviceId }));
    assert.equal(r.timezone, "America/New_York");
    assert.deepEqual(starts(r), [
      "2031-03-09T05:00:00.000Z", // 00:00 EST
      "2031-03-09T06:00:00.000Z", // 01:00 EST
      "2031-03-09T07:00:00.000Z", // 03:00 EDT (02:00 does not exist)
      "2031-03-09T08:00:00.000Z",
      "2031-03-09T09:00:00.000Z",
    ]);
    assert.equal(r.slots.at(-1)?.endsAt, "2031-03-09T10:00:00.000Z"); // 06:00 EDT
    // Booking the slot after the gap works and is stored at the right instant.
    const hold = await tx(env, ctx, (c) =>
      createHold(c, ctx, { startsAt: "2031-03-09T07:00:00.000Z", catalogueItemId: s.serviceId, resourceId: s.resourceIds[0] }),
    );
    assert.equal(hold.booking.startsAt, "2031-03-09T07:00:00.000Z");
    const again = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-03-09", catalogueItemId: s.serviceId }));
    assert.equal(again.slots.length, 4);
  });

  test("fall back (America/New_York, 2031-11-02): the same window is seven real hours", async () => {
    const { s, ctx } = await dstTenant("America/New_York", 0);
    const late = ctxFor(s.tenantId, { now: new Date("2031-10-20T00:00:00Z") });
    const r = await tx(env, late, (c) => checkAvailability(c, late, { from: "2031-11-02", catalogueItemId: s.serviceId }));
    assert.equal(r.slots.length, 7);
    assert.equal(r.slots[0]?.startsAt, "2031-11-02T04:00:00.000Z"); // 00:00 EDT
    assert.equal(r.slots.at(-1)?.endsAt, "2031-11-02T11:00:00.000Z"); // 06:00 EST
    const ordinary = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-03-16", catalogueItemId: s.serviceId }));
    assert.equal(ordinary.slots.length, 6, "a normal Sunday has six");
  });

  test("a zone with no DST (Asia/Kolkata) is unaffected", async () => {
    const { s, ctx } = await dstTenant("Asia/Kolkata", 0);
    const r = await tx(env, ctx, (c) => checkAvailability(c, ctx, { from: "2031-03-09", catalogueItemId: s.serviceId }));
    assert.equal(r.slots.length, 6);
    assert.equal(r.slots[0]?.startsAt, "2031-03-08T18:30:00.000Z");
  });
});

describe("pure helpers", () => {
  test("interval maths", () => {
    assert.deepEqual(normaliseIntervals([{ start: "12:00", end: "14:00" }, { start: "10:00", end: "12:00" }, { start: "13:00", end: "15:00" }]), [{ start: "10:00", end: "15:00" }]);
    assert.deepEqual(intersectIntervals([{ start: "10:00", end: "20:00" }], [{ start: "08:00", end: "12:00" }, { start: "18:00", end: "22:00" }]), [
      { start: "10:00", end: "12:00" },
      { start: "18:00", end: "20:00" },
    ]);
    assert.deepEqual(intersectIntervals([{ start: "10:00", end: "11:00" }], [{ start: "11:00", end: "12:00" }]), []);
  });

  test("peakUnits matches the database rule (peak over the window, not the sum of overlaps)", () => {
    const a = [
      { start: at(0), end: at(120), units: 3 },
      { start: at(120), end: at(240), units: 3 },
    ];
    assert.equal(peakUnits(a, Date.parse(at(60)), Date.parse(at(180))), 3);
    assert.equal(peakUnits([], Date.parse(at(0)), Date.parse(at(60))), 0);
    const b = [...a, { start: at(60), end: at(180), units: 1 }];
    assert.equal(peakUnits(b, Date.parse(at(0)), Date.parse(at(240))), 4);
  });

  test("slotsForResource and effectiveIntervals work without a database", () => {
    const inputs: ResourceAvailabilityInputs = {
      resource: { id: "r", name: "R", type: "staff", locationId: null, timezone: "Asia/Kolkata", allocationMode: "exclusive", capacityUnits: 1, minUnits: 1 },
      businessHours: [{ weekday: 1, start: "10:00", end: "12:00" }],
      resourceHours: [],
      holidays: [],
      breaks: null,
      timeOff: [],
      allocations: [],
      unreadable: false,
    };
    const defaults = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
    assert.deepEqual(effectiveIntervals(inputs, MONDAY, defaults), [{ start: "10:00", end: "12:00" }]);
    const slots = slotsForResource(inputs, [MONDAY], { durationMinutes: 60, bufferMinutes: 0, stepMinutes: 30, defaultHours: defaults, defaultBreaks: [] });
    assert.equal(slots.length, 3);
    assert.equal(slotsForResource({ ...inputs, unreadable: true }, [MONDAY], { durationMinutes: 60, bufferMinutes: 0, stepMinutes: 30, defaultHours: defaults, defaultBreaks: [] }).length, 0);
  });
});
