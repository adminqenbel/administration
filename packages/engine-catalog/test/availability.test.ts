import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateSlots, type SqlClient } from "@qenbel/shared";
import {
  addResourceTimeOff, archiveLocation, archiveCatalogueItem, archiveResource, createCatalogueItem, createHoliday, createLocation, createResource,
  createVariant, generateAllSlots, generateResourceSlots, intersectIntervals, loadAvailabilityInputs, peakUnits, setLocationHours,
  setResourceBreaks, setResourceSchedule, setResourceServices, slotRequestFor, updateVariant,
  type AvailabilityInputs,
} from "../src/index.ts";
import { NOW, call, connectTestDb, insertBooking, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const ghost = "11111111-1111-1111-1111-111111111111";
const MON = "2031-01-06";
const TUE = "2031-01-07";
const week = (days: Record<string, Array<[string, string]>>) => {
  const w: Record<string, Array<{ start: string; end: string }>> = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
  for (const [d, list] of Object.entries(days)) w[d] = list.map(([start, end]) => ({ start, end }));
  return w;
};
const WORKDAYS = (start = "09:00", end = "18:00") => week({ mon: [[start, end]], tue: [[start, end]], wed: [[start, end]], thu: [[start, end]], fri: [[start, end]] });
const ist = (date: string, hm: string): Date => new Date(`${date}T${hm}:00+05:30`);
const hmIst = (iso: string): string => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(11, 16);
const starts = (slots: Array<{ start: string }>): string[] => slots.map((s) => hmIst(s.start));

interface World {
  t: string;
  ctx: ReturnType<typeof makeCtx>;
  loc: string;
  service: string;
  a: string;
  b: string;
}

async function world(prefix: string, opts: { buffer?: number; duration?: number; hours?: Record<string, Array<{ start: string; end: string }>> } = {}): Promise<World> {
  const t = await db.createTenant(prefix);
  const ctx = makeCtx(t);
  const loc = await call(db, ctx, createLocation, { name: "Main" });
  await call(db, ctx, setLocationHours, { locationId: loc.id, hours: opts.hours ?? WORKDAYS() } as never);
  const service = await call(db, ctx, createCatalogueItem, {
    kind: "service", name: "Haircut", amountPaise: 50000, durationMinutes: opts.duration ?? 30, bufferMinutes: opts.buffer ?? 0, requiredResourceType: "staff",
  });
  const a = await call(db, ctx, createResource, { type: "staff", name: "Asha", locationId: loc.id });
  const b = await call(db, ctx, createResource, { type: "staff", name: "Bala", locationId: loc.id });
  return { t, ctx, loc: loc.id, service: service.id, a: a.id, b: b.id };
}

const load = (w: World, extra: Record<string, unknown> = {}): Promise<AvailabilityInputs> =>
  call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.service, from: MON, ...extra } as never);

const slotsOf = (inputs: AvailabilityInputs, resourceId: string, date = MON, step = 30) => {
  const r = inputs.resources.find((x) => x.resourceId === resourceId)!;
  return generateResourceSlots(inputs, r, date, { stepMinutes: step });
};

describe("shape of the inputs", () => {
  test("a plain day: timezone, window, service, one entry per resource, hours that generateSlots accepts", async () => {
    const w = await world("av-shape");
    const inputs = await load(w);
    assert.equal(inputs.timezone, "Asia/Kolkata");
    assert.equal(inputs.locationId, w.loc);
    assert.equal(inputs.from, MON);
    assert.equal(inputs.to, MON);
    assert.equal(inputs.window.start, "2031-01-05T18:30:00.000Z");
    assert.equal(inputs.window.end, "2031-01-06T18:30:00.000Z");
    assert.deepEqual(inputs.service, { id: w.service, name: "Haircut", variantId: null, durationMinutes: 30, bufferMinutes: 0 });
    assert.deepEqual(inputs.resources.map((r) => r.name), ["Asha", "Bala"]);
    const r = inputs.resources[0]!;
    assert.deepEqual(r.hours.mon, [{ start: "09:00", end: "18:00" }]);
    assert.deepEqual(r.hours.sat, []);
    assert.deepEqual(r.holidays, []);
    assert.deepEqual(r.dateOverrides, {});
    assert.deepEqual(r.breaks, []);
    assert.deepEqual(r.timeOff, []);
    assert.deepEqual(r.allocations, []);
    assert.equal(r.allocationMode, "exclusive");

    // The raw fields are exactly what shared generateSlots takes.
    const direct = generateSlots({ timezone: inputs.timezone, date: MON, hours: r.hours, breaks: r.breaks, holidays: r.holidays, allocations: r.allocations,
      durationMinutes: inputs.service.durationMinutes, bufferMinutes: inputs.service.bufferMinutes, stepMinutes: 30 });
    assert.equal(direct.length, 18);
    assert.deepEqual(slotsOf(inputs, w.a), direct);
    assert.equal(starts(direct)[0], "09:00");
    assert.equal(starts(direct).at(-1), "17:30");
  });

  test("a multi-day range reports every closed day and every day that differs from the weekly pattern", async () => {
    const w = await world("av-range");
    await call(db, w.ctx, createHoliday, { date: "2031-01-08", name: "Closed all" });
    await call(db, w.ctx, createHoliday, { locationId: w.loc, date: "2031-01-09", name: "Half day", closed: false, openTime: "09:00", closeTime: "13:00" });
    const inputs = await load(w, { from: MON, to: "2031-01-12" });
    const r = inputs.resources[0]!;
    assert.deepEqual(r.holidays, ["2031-01-08"]);
    assert.deepEqual(r.dateOverrides, { "2031-01-09": [{ start: "09:00", end: "13:00" }] });
    assert.equal(generateResourceSlots(inputs, r, "2031-01-08", { stepMinutes: 30 }).length, 0);
    assert.equal(generateResourceSlots(inputs, r, "2031-01-09", { stepMinutes: 30 }).length, 8);
    assert.equal(generateResourceSlots(inputs, r, "2031-01-10", { stepMinutes: 30 }).length, 18);
    assert.equal(generateResourceSlots(inputs, r, "2031-01-11", { stepMinutes: 30 }).length, 0, "Saturday is closed");
    // The request builder swaps in the override for that weekday only.
    assert.deepEqual(slotRequestFor(inputs, r, "2031-01-09").hours.thu, [{ start: "09:00", end: "13:00" }]);
    assert.deepEqual(slotRequestFor(inputs, r, "2031-01-10").hours.thu, [{ start: "09:00", end: "18:00" }]);
    // generateAllSlots covers every resource and date, ordered by time then name.
    const all = generateAllSlots(inputs, { stepMinutes: 60 });
    assert.equal(all.length, 2 * (9 + 9 + 0 + 4 + 9));
    const sorted = [...all].sort((x, y) => x.start.localeCompare(y.start) || x.resourceName.localeCompare(y.resourceName));
    assert.deepEqual(all, sorted);
  });

  test("the location's own holiday beats an all-location one on the same date", async () => {
    const w = await world("av-hol-prec");
    await call(db, w.ctx, createHoliday, { date: TUE, name: "Everyone closed" });
    await call(db, w.ctx, createHoliday, { locationId: w.loc, date: TUE, name: "We open late", closed: false, openTime: "12:00", closeTime: "15:00" });
    const inputs = await load(w, { from: TUE });
    assert.deepEqual(inputs.resources[0]!.holidays, []);
    assert.deepEqual(starts(slotsOf(inputs, w.a, TUE, 60)), ["12:00", "13:00", "14:00"]);
  });

  test("a holiday at another location does not apply", async () => {
    const w = await world("av-hol-other");
    const other = await call(db, w.ctx, createLocation, { name: "Other" });
    await call(db, w.ctx, createHoliday, { locationId: other.id, date: TUE, name: "Other closed" });
    const inputs = await load(w, { from: TUE });
    assert.deepEqual(inputs.resources[0]!.holidays, []);
  });
});

describe("breaks, schedules and time off", () => {
  test("breaks written as a gap in the location's hours keep slots out of the gap", async () => {
    const w = await world("av-gap", { hours: week({ mon: [["09:00", "13:00"], ["14:00", "18:00"]] }) });
    const inputs = await load(w);
    const s = starts(slotsOf(inputs, w.a, MON, 30));
    assert.ok(!s.includes("13:00") && !s.includes("13:30"));
    assert.ok(s.includes("12:30") && s.includes("14:00"));
    assert.equal(s.length, 8 + 8);
  });

  test("a resource's own daily breaks are applied by generateSlots", async () => {
    const w = await world("av-rbreak");
    await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [{ start: "15:00", end: "15:30" }] });
    const inputs = await load(w);
    assert.deepEqual(inputs.resources.find((r) => r.resourceId === w.a)!.breaks, [{ start: "15:00", end: "15:30" }]);
    assert.ok(!starts(slotsOf(inputs, w.a)).includes("15:00"));
    assert.ok(starts(slotsOf(inputs, w.b)).includes("15:00"), "the other resource has no break");
    // a 30-minute service starting at 14:45 would overlap the break
    assert.ok(!starts(slotsOf(inputs, w.a, MON, 15)).includes("14:45"));
  });

  test("a resource schedule narrows the location's hours; days it does not list are closed; a wider schedule is clipped", async () => {
    const w = await world("av-sched");
    await call(db, w.ctx, setResourceSchedule, { resourceId: w.a, hours: week({ mon: [["10:00", "16:00"]], wed: [["07:00", "20:00"]] }) } as never);
    const inputs = await load(w, { from: MON, to: "2031-01-08" });
    const a = inputs.resources.find((r) => r.resourceId === w.a)!;
    const b = inputs.resources.find((r) => r.resourceId === w.b)!;
    assert.deepEqual(a.hours.mon, [{ start: "10:00", end: "16:00" }]);
    assert.deepEqual(a.hours.tue, []);
    assert.deepEqual(a.hours.wed, [{ start: "09:00", end: "18:00" }], "clipped to the location's opening hours");
    assert.deepEqual(b.hours.mon, [{ start: "09:00", end: "18:00" }], "no schedule: follows the location");
    assert.deepEqual(starts(generateResourceSlots(inputs, a, MON, { stepMinutes: 60 })), ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"]);
    assert.equal(generateResourceSlots(inputs, a, TUE).length, 0);
  });

  test("a resource at a closed location day or holiday never opens, even if its schedule says so", async () => {
    const w = await world("av-sched-hol");
    await call(db, w.ctx, setResourceSchedule, { resourceId: w.a, hours: week({ tue: [["09:00", "18:00"]] }) } as never);
    await call(db, w.ctx, createHoliday, { date: TUE, name: "Closed" });
    const inputs = await load(w, { from: TUE });
    assert.equal(generateResourceSlots(inputs, inputs.resources.find((r) => r.resourceId === w.a)!, TUE).length, 0);
  });

  test("time off removes slots; generateSlots on its own would not know, generateResourceSlots does", async () => {
    const w = await world("av-off");
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: ist(MON, "11:00").toISOString(), endsAt: ist(MON, "12:15").toISOString(), reason: "Dentist" });
    const inputs = await load(w);
    const a = inputs.resources.find((r) => r.resourceId === w.a)!;
    assert.equal(a.timeOff.length, 1);
    const s = starts(generateResourceSlots(inputs, a, MON, { stepMinutes: 15 }));
    for (const blocked of ["10:45", "11:00", "11:30", "12:00"]) assert.ok(!s.includes(blocked), `${blocked} overlaps time off`);
    for (const ok of ["10:30", "12:15", "12:30"]) assert.ok(s.includes(ok), `${ok} is clear of time off`);
    assert.ok(starts(generateSlots(slotRequestFor(inputs, a, MON, { stepMinutes: 15 }))).includes("11:00"), "plain generateSlots ignores time off");
    // time off outside the requested window is not even loaded
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.b, startsAt: "2031-02-01T00:00:00Z", endsAt: "2031-02-02T00:00:00Z" });
    assert.deepEqual((await load(w)).resources.find((r) => r.resourceId === w.b)!.timeOff, []);
    // a multi-day absence blocks every day of the range
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.b, startsAt: ist(MON, "00:00").toISOString(), endsAt: ist("2031-01-09", "00:00").toISOString() });
    const multi = await load(w, { from: MON, to: "2031-01-09" });
    const b = multi.resources.find((r) => r.resourceId === w.b)!;
    assert.equal(generateResourceSlots(multi, b, MON).length + generateResourceSlots(multi, b, TUE).length + generateResourceSlots(multi, b, "2031-01-08").length, 0);
    assert.ok(generateResourceSlots(multi, b, "2031-01-09").length > 0);
  });
});

describe("existing allocations", () => {
  test("confirmed bookings and live holds block; expired holds, cancelled bookings and other resources do not", async () => {
    const w = await world("av-alloc");
    await tx(db, w.t, async (c) => {
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "10:00"), to: ist(MON, "10:30") });
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "11:00"), to: ist(MON, "11:30"), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() + 600_000) });
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "12:00"), to: ist(MON, "12:30"), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() - 1000) });
      const cancelled = await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "13:00"), to: ist(MON, "13:30") });
      await c.query("update bookings set status = 'CANCELLED' where tenant_id = $1 and id = $2", [w.t, cancelled]);
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.b, from: ist(MON, "14:00"), to: ist(MON, "14:30") });
    });
    const inputs = await load(w);
    const a = inputs.resources.find((r) => r.resourceId === w.a)!;
    const b = inputs.resources.find((r) => r.resourceId === w.b)!;
    assert.equal(a.allocations.length, 2);
    assert.equal(b.allocations.length, 1);
    assert.ok(a.allocations.every((x) => x.units === 1));
    const sa = starts(slotsOf(inputs, w.a));
    assert.ok(!sa.includes("10:00") && !sa.includes("11:00"));
    assert.ok(sa.includes("12:00"), "expired hold is free");
    assert.ok(sa.includes("13:00"), "cancelled booking is free");
    assert.ok(sa.includes("14:00"), "another resource's booking does not block");
    assert.ok(!starts(slotsOf(inputs, w.b)).includes("14:00"));
  });

  test("the service's buffer keeps the next slot clear of an existing booking", async () => {
    const w = await world("av-buffer", { buffer: 10 });
    await tx(db, w.t, (c) => insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "10:00"), to: ist(MON, "10:30") }));
    const inputs = await load(w);
    assert.equal(inputs.service.bufferMinutes, 10);
    const s = starts(slotsOf(inputs, w.a, MON, 10));
    assert.ok(!s.includes("10:30") && !s.includes("10:20"), "within 10 minutes after the booking");
    assert.ok(s.includes("10:40"));
    assert.ok(!s.includes("09:30") && !s.includes("09:40"), "the buffer also keeps the slot before clear");
    assert.ok(s.includes("09:20"));
  });

  test("allocations just outside the window but inside the buffer reach are still loaded", async () => {
    const w = await world("av-edge", { buffer: 30 });
    await tx(db, w.t, async (c) => {
      // ends 20 minutes before the window starts: inside buffer reach
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: new Date(Date.parse("2031-01-05T18:30:00Z") - 50 * 60_000), to: new Date(Date.parse("2031-01-05T18:30:00Z") - 20 * 60_000) });
      // ends 3 hours before: out of reach
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.b, from: new Date(Date.parse("2031-01-05T18:30:00Z") - 240 * 60_000), to: new Date(Date.parse("2031-01-05T18:30:00Z") - 180 * 60_000) });
    });
    const inputs = await load(w);
    assert.equal(inputs.resources.find((r) => r.resourceId === w.a)!.allocations.length, 1);
    assert.equal(inputs.resources.find((r) => r.resourceId === w.b)!.allocations.length, 0);
  });

  test("excludeBookingId leaves that booking's own time free (reschedule)", async () => {
    const w = await world("av-exclude");
    const own = await tx(db, w.t, async (c) => {
      const id = await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "10:00"), to: ist(MON, "10:30") });
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: w.a, from: ist(MON, "11:00"), to: ist(MON, "11:30") });
      return id;
    });
    const plain = await load(w);
    assert.equal(plain.resources.find((r) => r.resourceId === w.a)!.allocations.length, 2);
    const ex = await load(w, { excludeBookingId: own });
    const a = ex.resources.find((r) => r.resourceId === w.a)!;
    assert.equal(a.allocations.length, 1);
    assert.ok(starts(generateResourceSlots(ex, a, MON)).includes("10:00"));
    assert.ok(!starts(generateResourceSlots(ex, a, MON)).includes("11:00"));
  });
});

describe("shared-capacity resources", () => {
  test("slots are offered while units remain; allocations do not block each other", async () => {
    const w = await world("av-shared");
    const room = await call(db, w.ctx, createResource, { type: "room", name: "Studio", locationId: w.loc, allocationMode: "shared", capacityUnits: 4 });
    const klass = await call(db, w.ctx, createCatalogueItem, { kind: "service", name: "Group class", amountPaise: 20000, durationMinutes: 60, requiredResourceType: "room" });
    await tx(db, w.t, async (c) => {
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: room.id, from: ist(MON, "10:00"), to: ist(MON, "11:00"), units: 3 });
      await insertBooking(c, w.t, { locationId: w.loc, resourceId: room.id, from: ist(MON, "10:30"), to: ist(MON, "11:30"), units: 1 });
    });
    const inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: klass.id, from: MON });
    assert.deepEqual(inputs.resources.map((r) => r.name), ["Studio"], "only the room is eligible for this class");
    const r = inputs.resources[0]!;
    assert.equal(r.allocationMode, "shared");
    assert.equal(r.capacityUnits, 4);
    assert.equal(r.allocations.length, 2);
    assert.deepEqual(slotRequestFor(inputs, r, MON).allocations, [], "generateSlots must not treat shared allocations as blocking");
    const s1 = starts(generateResourceSlots(inputs, r, MON, { stepMinutes: 30, units: 1 }));
    const s2 = starts(generateResourceSlots(inputs, r, MON, { stepMinutes: 30, units: 2 }));
    assert.ok(!s1.includes("10:30") && !s1.includes("10:00"), "4 of 4 in use between 10:30 and 11:00");
    assert.ok(s1.includes("09:30"), "09:30-10:30 peaks at 3 of 4, one more fits");
    assert.ok(s1.includes("09:00") && s1.includes("11:30") && s1.includes("12:00"));
    assert.ok(!s2.includes("09:30") && !s2.includes("10:00") && !s2.includes("10:30"), "two more would exceed 4");
    assert.ok(s2.includes("11:00") && s2.includes("11:30"), "11:00-12:00 has 1 in use, 1+2 fits");
    assert.deepEqual(starts(generateResourceSlots(inputs, r, MON, { stepMinutes: 30, units: 5 })), [], "more units than capacity: nothing");
  });

  test("peakUnits is the highest concurrent use, not the sum", () => {
    const alloc = (a: string, b: string, units: number) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), units });
    const list = [alloc("2031-01-06T10:00:00Z", "2031-01-06T12:00:00Z", 3), alloc("2031-01-06T12:00:00Z", "2031-01-06T14:00:00Z", 3)];
    assert.equal(peakUnits(list, "2031-01-06T10:00:00Z", "2031-01-06T14:00:00Z"), 3);
    assert.equal(peakUnits(list, "2031-01-06T11:00:00Z", "2031-01-06T13:00:00Z"), 3);
    assert.equal(peakUnits(list, "2031-01-06T14:00:00Z", "2031-01-06T15:00:00Z"), 0);
    assert.equal(peakUnits([...list, alloc("2031-01-06T11:00:00Z", "2031-01-06T13:00:00Z", 1)], "2031-01-06T11:00:00Z", "2031-01-06T13:00:00Z"), 4);
  });
});

describe("which resources qualify", () => {
  test("type rule, explicit links, archived and inactive resources, resourceIds, resourceType and party size", async () => {
    const w = await world("av-elig");
    const room = await call(db, w.ctx, createResource, { type: "room", name: "Room", locationId: w.loc });
    const archived = await call(db, w.ctx, createResource, { type: "staff", name: "Archived", locationId: w.loc });
    await call(db, w.ctx, archiveResource, { resourceId: archived.id });
    await call(db, w.ctx, createResource, { type: "staff", name: "Inactive", locationId: w.loc, active: false });
    const elsewhere = await call(db, w.ctx, createLocation, { name: "Elsewhere" });
    await call(db, w.ctx, createResource, { type: "staff", name: "Elsewhere staff", locationId: elsewhere.id });
    const floating = await call(db, w.ctx, createResource, { type: "staff", name: "Floating" });
    const names = async (extra: Record<string, unknown> = {}) => (await load(w, extra)).resources.map((r) => r.name);
    assert.deepEqual(await names(), ["Asha", "Bala", "Floating"], "no location means every location");
    assert.deepEqual(await names({ resourceIds: [w.a, room.id, archived.id, ghost] }), ["Asha"]);
    await call(db, w.ctx, setResourceServices, { resourceId: room.id, serviceIds: [w.service] });
    assert.deepEqual(await names(), ["Asha", "Bala", "Floating", "Room"]);
    assert.deepEqual(await names({ resourceType: "room" }), ["Room"]);
    void floating;
  });

  test("without a service: duration comes from the call, party size selects tables that fit", async () => {
    const t = await db.createTenant("av-tables");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Restaurant" });
    await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ mon: [["12:00", "15:00"], ["19:00", "23:00"]] }) } as never);
    await call(db, ctx, createResource, { type: "table", name: "T2", locationId: loc.id, capacityUnits: 2 });
    await call(db, ctx, createResource, { type: "table", name: "T4", locationId: loc.id, capacityUnits: 4, minUnits: 3 });
    await call(db, ctx, createResource, { type: "table", name: "T8", locationId: loc.id, capacityUnits: 8, minUnits: 5 });
    const counter = await call(db, ctx, createResource, { type: "table", name: "Counter", locationId: loc.id, allocationMode: "shared", capacityUnits: 6 });
    const q = (extra: Record<string, unknown>) => call(db, ctx, loadAvailabilityInputs, { locationId: loc.id, from: MON, durationMinutes: 90, ...extra } as never);
    assert.deepEqual((await q({})).resources.map((r) => r.name), ["Counter", "T2", "T4", "T8"]);
    assert.deepEqual((await q({ partySize: 2 })).resources.map((r) => r.name), ["Counter", "T2", "T4", "T8"].filter((n) => n !== "T4" && n !== "T8"));
    assert.deepEqual((await q({ partySize: 3 })).resources.map((r) => r.name), ["Counter", "T4", "T8"].filter((n) => n !== "T8"));
    assert.deepEqual((await q({ partySize: 6 })).resources.map((r) => r.name), ["Counter", "T8"]);
    assert.deepEqual((await q({ partySize: 9 })).resources.map((r) => r.name), []);
    const inputs = await q({ partySize: 4 });
    assert.deepEqual(inputs.service, { id: null, name: null, variantId: null, durationMinutes: 90, bufferMinutes: 0 });
    const t4 = inputs.resources.find((r) => r.name === "T4")!;
    assert.deepEqual(starts(generateResourceSlots(inputs, t4, MON, { stepMinutes: 90 })), ["12:00", "13:30", "19:00", "20:30"]);
    void counter;
  });
});

describe("service and variant rules, and bad input", () => {
  test("variant duration overrides the service's; inactive or foreign variants, products, archived and unavailable services are refused", async () => {
    const w = await world("av-variant");
    const long = await call(db, w.ctx, createVariant, { itemId: w.service, name: "Long", amountPaise: 90000, durationMinutes: 90 });
    const plainVar = await call(db, w.ctx, createVariant, { itemId: w.service, name: "Same length", amountPaise: 50000 });
    const inputs = await load(w, { variantId: long.id });
    assert.equal(inputs.service.durationMinutes, 90);
    assert.equal(inputs.service.variantId, long.id);
    assert.equal((await load(w, { variantId: plainVar.id })).service.durationMinutes, 30);
    await call(db, w.ctx, updateVariant, { variantId: long.id, active: false });
    await rejectsWith(load(w, { variantId: long.id }), "NOT_FOUND");
    const other = await call(db, w.ctx, createCatalogueItem, { kind: "service", name: "Other", amountPaise: 1, durationMinutes: 15 });
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: other.id, variantId: plainVar.id, from: MON } as never), "NOT_FOUND");
    const product = await call(db, w.ctx, createCatalogueItem, { kind: "product", name: "Gel", amountPaise: 1 });
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: product.id, from: MON } as never), "NOT_FOUND");
    const off = await call(db, w.ctx, createCatalogueItem, { kind: "service", name: "Off", amountPaise: 1, durationMinutes: 15, available: false });
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: off.id, from: MON } as never), "CONFLICT");
    await call(db, w.ctx, archiveCatalogueItem, { itemId: other.id });
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: other.id, from: MON } as never), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: ghost, from: MON } as never), "NOT_FOUND");
  });

  test("argument rules: a duration or a service, not both; dates valid, ordered and at most 31 days; unknown keys refused", async () => {
    const w = await world("av-args");
    const base = { locationId: w.loc, serviceId: w.service, from: MON };
    const bad: Array<Record<string, unknown>> = [
      { locationId: w.loc, from: MON },
      { ...base, durationMinutes: 30 },
      { ...base, bufferMinutes: 5 },
      { locationId: w.loc, durationMinutes: 30, variantId: ghost, from: MON },
      { locationId: w.loc, durationMinutes: 0, from: MON },
      { ...base, from: "2031-13-01" },
      { ...base, from: "06/01/2031" },
      { ...base, to: "2031-01-05" },
      { ...base, to: "2031-02-06" },
      { ...base, resourceIds: [] },
      { ...base, partySize: 0 },
      { ...base, tenantId: w.t },
      { ...base, tenant_id: w.t },
      { ...base, extra: true },
    ];
    for (const input of bad) await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, input as never), "VALIDATION_FAILED");
    const ok = await call(db, w.ctx, loadAvailabilityInputs, { ...base, to: "2031-02-05" } as never);
    assert.equal(ok.to, "2031-02-05", "31 days is allowed");
  });

  test("an archived or unknown location is NOT_FOUND", async () => {
    const w = await world("av-loc");
    const extra = await call(db, w.ctx, createLocation, { name: "Temp" });
    await call(db, makeCtx(w.t, { now: new Date("2031-06-01T00:00:00Z") }), archiveLocation, { locationId: extra.id });
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: extra.id, serviceId: w.service, from: MON }), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, loadAvailabilityInputs, { locationId: ghost, serviceId: w.service, from: MON }), "NOT_FOUND");
  });
});

describe("time zones", () => {
  test("a daylight saving day is 23 hours: window, slot count and allocations at the far edge are right", async () => {
    const t = await db.createTenant("av-dst");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "NYC", timezone: "America/New_York" });
    await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ sun: [["00:00", "24:00"]] }) } as never);
    const svc = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Hour", amountPaise: 1, durationMinutes: 60 });
    const res = await call(db, ctx, createResource, { type: "staff", name: "Pat", locationId: loc.id });
    const DST = "2031-03-09";
    // 22:30-23:30 local on the 9th (EDT, UTC-4) is 02:30-03:30 UTC on the 10th
    await tx(db, t, (c) => insertBooking(c, t, { locationId: loc.id, resourceId: res.id, from: new Date("2031-03-10T02:30:00Z"), to: new Date("2031-03-10T03:30:00Z") }));
    const inputs = await call(db, ctx, loadAvailabilityInputs, { locationId: loc.id, serviceId: svc.id, from: DST });
    assert.equal(inputs.window.start, "2031-03-09T05:00:00.000Z");
    assert.equal(inputs.window.end, "2031-03-10T04:00:00.000Z");
    assert.equal((Date.parse(inputs.window.end) - Date.parse(inputs.window.start)) / 3_600_000, 23);
    const r = inputs.resources[0]!;
    assert.equal(r.allocations.length, 1);
    const slots = generateResourceSlots(inputs, r, DST, { stepMinutes: 60 });
    assert.equal(slots.length, 23 - 2, "23 hourly slots, minus the two the booking overlaps");
  });

  test("a location west of UTC and one east give different windows for the same date", async () => {
    const t = await db.createTenant("av-tz");
    const ctx = makeCtx(t);
    const svc = await call(db, ctx, createCatalogueItem, { kind: "service", name: "S", amountPaise: 1, durationMinutes: 30 });
    const mk = async (name: string, timezone: string) => (await call(db, ctx, createLocation, { name, timezone })).id;
    const kolkata = await mk("K", "Asia/Kolkata");
    const la = await mk("LA", "America/Los_Angeles");
    const w = async (locationId: string) => (await call(db, ctx, loadAvailabilityInputs, { locationId, serviceId: svc.id, from: MON })).window;
    assert.equal((await w(kolkata)).start, "2031-01-05T18:30:00.000Z");
    assert.equal((await w(la)).start, "2031-01-06T08:00:00.000Z");
  });
});

describe("efficiency", () => {
  test("the number of queries does not grow with the number of resources", async () => {
    const w = await world("av-queries");
    for (let i = 0; i < 25; i++) await call(db, w.ctx, createResource, { type: "staff", name: `Extra ${i}`, locationId: w.loc });
    await call(db, w.ctx, setResourceSchedule, { resourceId: w.a, hours: week({ mon: [["10:00", "16:00"]] }) } as never);
    let queries = 0;
    const counted = await tx(db, w.t, async (c) => {
      const spy: SqlClient = { query: ((text: string, values?: readonly unknown[]) => { queries++; return c.query(text, values as unknown[]); }) as SqlClient["query"] };
      return loadAvailabilityInputs(spy, w.ctx, { locationId: w.loc, serviceId: w.service, from: MON, to: "2031-01-12" });
    });
    assert.equal(counted.resources.length, 27);
    assert.ok(queries <= 8, `expected a constant number of queries, got ${queries}`);
  });
});

describe("tenant isolation", () => {
  test("tenant A cannot load tenant B's location, service, resources or bookings", async () => {
    const a = await world("av-iso-a");
    const b = await world("av-iso-b");
    await tx(db, b.t, (c) => insertBooking(c, b.t, { locationId: b.loc, resourceId: b.a, from: ist(MON, "10:00"), to: ist(MON, "10:30") }));
    await rejectsWith(call(db, a.ctx, loadAvailabilityInputs, { locationId: b.loc, serviceId: a.service, from: MON }), "NOT_FOUND");
    await rejectsWith(call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: b.service, from: MON }), "NOT_FOUND");
    const viaIds = await call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: a.service, from: MON, resourceIds: [b.a, b.b] });
    assert.deepEqual(viaIds.resources, [], "B's resource ids select nothing in A");
    const own = await call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: a.service, from: MON });
    assert.ok(own.resources.every((r) => r.allocations.length === 0), "B's booking never shows in A's inputs");
    assert.ok(own.resources.every((r) => r.resourceId === a.a || r.resourceId === a.b));
    await rejectsWith(call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: a.service, from: MON, excludeBookingId: ghost, tenantId: b.t } as never), "VALIDATION_FAILED");
    // and B's own inputs do include it
    const bOwn = await call(db, b.ctx, loadAvailabilityInputs, { locationId: b.loc, serviceId: b.service, from: MON });
    assert.equal(bOwn.resources.find((r) => r.resourceId === b.a)!.allocations.length, 1);
  });

  test("holidays, time off and breaks of another tenant never leak in", async () => {
    const a = await world("av-leak-a");
    const b = await world("av-leak-b");
    await call(db, b.ctx, createHoliday, { date: MON, name: "B closed" });
    await call(db, b.ctx, setResourceBreaks, { resourceId: b.a, breaks: [{ start: "12:00", end: "13:00" }] });
    await call(db, b.ctx, addResourceTimeOff, { resourceId: b.a, startsAt: ist(MON, "09:00").toISOString(), endsAt: ist(MON, "18:00").toISOString() });
    const inputs = await call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: a.service, from: MON });
    for (const r of inputs.resources) {
      assert.deepEqual(r.holidays, []);
      assert.deepEqual(r.breaks, []);
      assert.deepEqual(r.timeOff, []);
    }
    assert.equal(generateAllSlots(inputs, { stepMinutes: 30 }).length, 2 * 18);
  });
});

describe("intersectIntervals", () => {
  test("pairs of interval lists", () => {
    const iv = (s: string, e: string) => ({ start: s, end: e });
    assert.deepEqual(intersectIntervals([iv("09:00", "13:00"), iv("14:00", "18:00")], [iv("12:00", "15:00")]), [iv("12:00", "13:00"), iv("14:00", "15:00")]);
    assert.deepEqual(intersectIntervals([iv("09:00", "10:00")], [iv("10:00", "11:00")]), []);
    assert.deepEqual(intersectIntervals([iv("00:00", "24:00")], [iv("08:00", "24:00")]), [iv("08:00", "24:00")]);
    assert.deepEqual(intersectIntervals([], [iv("08:00", "09:00")]), []);
  });
});
