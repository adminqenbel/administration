import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  addResourceTimeOff, archiveResource, createCatalogueItem, createLocation, createResource, getResource, getResourceBreaks, getResourceSchedule,
  listResourceTimeOff, listResources, listResourcesForService, removeResourceTimeOff, restoreResource, setResourceBreaks, setResourceSchedule,
  setResourceServices, updateResource, archiveCatalogueItem,
} from "../src/index.ts";
import { NOW, at, call, connectTestDb, insertBooking, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const ghost = "11111111-1111-1111-1111-111111111111";
const week = (days: Record<string, Array<[string, string]>>) => {
  const w: Record<string, Array<{ start: string; end: string }>> = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
  for (const [d, list] of Object.entries(days)) w[d] = list.map(([start, end]) => ({ start, end }));
  return w;
};
const staff = (name: string, extra: Record<string, unknown> = {}) => ({ type: "staff", name, ...extra });

describe("create, read, update", () => {
  test("a staff resource and a shared-capacity resource", async () => {
    const t = await db.createTenant("res-create");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Main" });
    const s = await call(db, ctx, createResource, staff("Asha", { locationId: loc.id, attributes: { skill: "senior" } }) as never);
    assert.equal(s.type, "staff");
    assert.equal(s.allocationMode, "exclusive");
    assert.equal(s.capacityUnits, 1);
    assert.equal(s.locationId, loc.id);
    assert.equal(s.active, true);
    assert.deepEqual(s.attributes, { skill: "senior" });
    assert.deepEqual(s.serviceIds, []);
    const room = await call(db, ctx, createResource, { type: "room", name: "Yoga room", allocationMode: "shared", capacityUnits: 12 });
    assert.equal(room.allocationMode, "shared");
    assert.equal(room.capacityUnits, 12);
    const table = await call(db, ctx, createResource, { type: "table", name: "T4", capacityUnits: 4, minUnits: 2 });
    assert.equal(table.minUnits, 2);
    assert.equal((await call(db, ctx, getResource, { resourceId: s.id })).name, "Asha");
  });

  test("bad input: unknown type or mode, minUnits above capacity, non-plain attributes, smuggled keys", async () => {
    const t = await db.createTenant("res-bad");
    const other = await db.createTenant("res-bad-o");
    const ctx = makeCtx(t);
    await rejectsWith(call(db, ctx, createResource, { type: "spaceship", name: "X" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, { type: "room", name: "X", allocationMode: "chaotic" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, { type: "table", name: "X", capacityUnits: 2, minUnits: 3 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, { type: "table", name: "X", capacityUnits: 0 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, staff("X", { attributes: { timeOff: [] } }) as never), "VALIDATION_FAILED"); // arrays are not scalars
    await rejectsWith(call(db, ctx, createResource, staff("X", { attributes: { nested: { a: 1 } } }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, staff("X", { tenantId: other }) as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createResource, staff("X", { locationId: ghost }) as never), "NOT_FOUND");
    assert.equal((await call(db, ctx, listResources, {})).items.length, 0);
  });

  test("update changes given fields; type cannot change; replacing attributes keeps schedule-adjacent data", async () => {
    const t = await db.createTenant("res-update");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("Old", { attributes: { a: "1" } }) as never);
    await call(db, ctx, setResourceBreaks, { resourceId: r.id, breaks: [{ start: "13:00", end: "14:00" }] });
    await call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: "2031-03-01T00:00:00Z", endsAt: "2031-03-02T00:00:00Z", reason: "Trip" });
    const u = await call(db, ctx, updateResource, { resourceId: r.id, name: "New", attributes: { b: "2" }, active: false });
    assert.equal(u.name, "New");
    assert.equal(u.active, false);
    assert.deepEqual(u.attributes, { b: "2" });
    assert.deepEqual((await call(db, ctx, getResourceBreaks, { resourceId: r.id })).breaks, [{ start: "13:00", end: "14:00" }]);
    assert.equal((await call(db, ctx, listResourceTimeOff, { resourceId: r.id })).length, 1);
    await rejectsWith(call(db, ctx, updateResource, { resourceId: r.id, type: "room" } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateResource, { resourceId: r.id }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateResource, { resourceId: r.id, minUnits: 5 }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateResource, { resourceId: ghost, name: "x" }), "NOT_FOUND");
  });

  test("the database refuses a mode change or capacity cut while allocations are active (CONFLICT)", async () => {
    const t = await db.createTenant("res-mode");
    const ctx = makeCtx(t);
    const room = await call(db, ctx, createResource, { type: "room", name: "Hall", allocationMode: "shared", capacityUnits: 10 });
    await tx(db, t, (c) => insertBooking(c, t, { resourceId: room.id, from: at(600), to: at(660), units: 3 }));
    await rejectsWith(call(db, ctx, updateResource, { resourceId: room.id, allocationMode: "exclusive" }), "CONFLICT");
    await rejectsWith(call(db, ctx, updateResource, { resourceId: room.id, capacityUnits: 5 }), "CONFLICT");
    const grown = await call(db, ctx, updateResource, { resourceId: room.id, capacityUnits: 20 });
    assert.equal(grown.capacityUnits, 20);
  });
});

describe("archive instead of delete", () => {
  test("refused while upcoming bookings exist, with the number; expired holds, cancelled and past bookings do not count", async () => {
    const t = await db.createTenant("res-archive");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("Busy") as never);
    const ids = await tx(db, t, async (c) => {
      const confirmed = await insertBooking(c, t, { resourceId: r.id, from: at(600), to: at(660) });
      const liveHold = await insertBooking(c, t, { resourceId: r.id, from: at(700), to: at(760), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() + 600_000) });
      await insertBooking(c, t, { resourceId: r.id, from: at(800), to: at(860), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() - 1000) });
      const past = await insertBooking(c, t, { resourceId: r.id, from: new Date(NOW.getTime() - 7200_000), to: new Date(NOW.getTime() - 3600_000) });
      return { confirmed, liveHold, past };
    });
    const err = await rejectsWith(call(db, ctx, archiveResource, { resourceId: r.id }), "CONFLICT");
    assert.equal(err.details.upcomingBookings, 2);
    assert.match(err.message, /2 upcoming bookings/);
    await tx(db, t, (c) => c.query("update bookings set status = 'CANCELLED' where tenant_id = $1 and id = any($2::uuid[])", [t, [ids.confirmed, ids.liveHold]]));
    const arch = await call(db, ctx, archiveResource, { resourceId: r.id });
    assert.ok(arch.archivedAt);
    assert.equal((await call(db, ctx, archiveResource, { resourceId: r.id })).archivedAt, arch.archivedAt, "idempotent");
    assert.equal((await call(db, ctx, listResources, {})).items.length, 0);
    assert.equal((await call(db, ctx, listResources, { archived: "only" })).items.length, 1);
    assert.equal((await call(db, ctx, getResource, { resourceId: r.id })).name, "Busy", "history still reads");
    await rejectsWith(call(db, ctx, updateResource, { resourceId: r.id, name: "x" }), "CONFLICT");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: "2031-04-01T00:00:00Z", endsAt: "2031-04-02T00:00:00Z" }), "CONFLICT");
    const back = await call(db, ctx, restoreResource, { resourceId: r.id });
    assert.equal(back.archivedAt, null);
    await rejectsWith(call(db, ctx, restoreResource, { resourceId: ghost }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, archiveResource, { resourceId: ghost }), "NOT_FOUND");
  });

  test("singular wording for one booking", async () => {
    const t = await db.createTenant("res-archive-one");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("One") as never);
    await tx(db, t, (c) => insertBooking(c, t, { resourceId: r.id, from: at(600), to: at(660) }));
    const err = await rejectsWith(call(db, ctx, archiveResource, { resourceId: r.id }), "CONFLICT");
    assert.match(err.message, /1 upcoming booking\./);
  });
});

describe("weekly schedule", () => {
  test("set, read, replace, and clear back to the location's hours", async () => {
    const t = await db.createTenant("res-sched");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("S") as never);
    const empty = await call(db, ctx, getResourceSchedule, { resourceId: r.id });
    assert.equal(empty.hasSchedule, false);
    const s = await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["09:00", "12:00"], ["13:00", "17:00"]], wed: [["10:00", "14:00"]] }) } as never);
    assert.equal(s.hasSchedule, true);
    assert.deepEqual(s.hours.mon, [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }]);
    const again = await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ fri: [["08:00", "09:00"]] }) } as never);
    assert.deepEqual(again.hours.mon, []);
    assert.deepEqual(again.hours.fri, [{ start: "08:00", end: "09:00" }]);
    const cleared = await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({}) } as never);
    assert.equal(cleared.hasSchedule, false);
    await rejectsWith(call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["12:00", "09:00"]] }) } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, setResourceSchedule, { resourceId: ghost, hours: week({}) } as never), "NOT_FOUND");
  });

  test("shortening the schedule over a live booking is refused with the count (R6.5); cancelled and past bookings are ignored", async () => {
    const t = await db.createTenant("res-sched-r65");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("S") as never);
    await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["09:00", "17:00"]] }) } as never);
    // Monday 2031-01-06 10:00-11:00 IST is 04:30-05:30 UTC = at(270)..at(330) in the test clock (at(0) = 00:00 UTC)
    const booked = await tx(db, t, async (c) => {
      const live = await insertBooking(c, t, { resourceId: r.id, from: at(270), to: at(330) });
      const cancelled = await insertBooking(c, t, { resourceId: r.id, from: at(400), to: at(460) });
      await c.query("update bookings set status = 'CANCELLED' where tenant_id = $1 and id = $2", [t, cancelled]);
      await insertBooking(c, t, { resourceId: r.id, from: new Date(NOW.getTime() - 86_400_000 * 3), to: new Date(NOW.getTime() - 86_400_000 * 3 + 3600_000) });
      return live;
    });
    assert.ok(booked);
    const e1 = await rejectsWith(call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["12:00", "17:00"]] }) } as never), "CONFLICT");
    assert.equal(e1.details.affectedBookings, 1);
    const e2 = await rejectsWith(call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ tue: [["09:00", "17:00"]] }) } as never), "CONFLICT");
    assert.equal(e2.details.affectedBookings, 1);
    const e3 = await rejectsWith(call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["09:00", "10:30"]] }) } as never), "CONFLICT");
    assert.equal(e3.details.affectedBookings, 1, "a booking must fit wholly inside one interval");
    // unchanged by the refusals
    assert.deepEqual((await call(db, ctx, getResourceSchedule, { resourceId: r.id })).hours.mon, [{ start: "09:00", end: "17:00" }]);
    // a wider or equal schedule is fine, and so is clearing
    await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({ mon: [["08:00", "18:00"]], tue: [["09:00", "10:00"]] }) } as never);
    await call(db, ctx, setResourceSchedule, { resourceId: r.id, hours: week({}) } as never);
  });
});

describe("time off", () => {
  test("add, list, remove; ids are unique; ordered by start", async () => {
    const t = await db.createTenant("res-off");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("Off") as never);
    const b = await call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: "2031-03-10T00:00:00+05:30", endsAt: "2031-03-12T00:00:00+05:30", reason: "Holiday" });
    const a = await call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: "2031-03-01T09:00:00Z", endsAt: "2031-03-01T13:00:00Z" });
    assert.notEqual(a.id, b.id);
    assert.equal(a.reason, null);
    assert.equal(b.startsAt, "2031-03-09T18:30:00.000Z");
    const list = await call(db, ctx, listResourceTimeOff, { resourceId: r.id });
    assert.deepEqual(list.map((x) => x.id), [a.id, b.id]);
    const window = await call(db, ctx, listResourceTimeOff, { resourceId: r.id, from: "2031-03-11T00:00:00Z", to: "2031-03-20T00:00:00Z" });
    assert.deepEqual(window.map((x) => x.id), [b.id]);
    assert.deepEqual(await call(db, ctx, removeResourceTimeOff, { resourceId: r.id, timeOffId: a.id }), { deleted: true });
    await rejectsWith(call(db, ctx, removeResourceTimeOff, { resourceId: r.id, timeOffId: a.id }), "NOT_FOUND");
    assert.equal((await call(db, ctx, listResourceTimeOff, { resourceId: r.id })).length, 1);
  });

  test("refused over live bookings with their count (R6.5); touching a booking's edge is fine", async () => {
    const t = await db.createTenant("res-off-booked");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("Booked") as never);
    await tx(db, t, async (c) => {
      await insertBooking(c, t, { resourceId: r.id, from: at(600), to: at(660) });
      await insertBooking(c, t, { resourceId: r.id, from: at(700), to: at(760) });
    });
    const err = await rejectsWith(call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: at(630).toISOString(), endsAt: at(730).toISOString() }), "CONFLICT");
    assert.equal(err.details.affectedBookings, 2);
    await call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: at(660).toISOString(), endsAt: at(700).toISOString() });
    await call(db, ctx, addResourceTimeOff, { resourceId: r.id, startsAt: at(500).toISOString(), endsAt: at(600).toISOString() });
    assert.equal((await call(db, ctx, listResourceTimeOff, { resourceId: r.id })).length, 2);
  });

  test("bad ranges and smuggled keys are refused", async () => {
    const t = await db.createTenant("res-off-bad");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("Bad") as never);
    const base = { resourceId: r.id, startsAt: "2031-03-01T00:00:00Z", endsAt: "2031-03-02T00:00:00Z" };
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, endsAt: base.startsAt }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, endsAt: "2031-02-28T00:00:00Z" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, endsAt: "2033-03-02T00:00:00Z" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, startsAt: "yesterday" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, startsAt: "2031-03-01" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, tenantId: t } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, addResourceTimeOff, { ...base, resourceId: ghost }), "NOT_FOUND");
  });
});

describe("daily breaks", () => {
  test("set, read, clear; overlapping breaks refused", async () => {
    const t = await db.createTenant("res-breaks");
    const ctx = makeCtx(t);
    const r = await call(db, ctx, createResource, staff("B") as never);
    const set = await call(db, ctx, setResourceBreaks, { resourceId: r.id, breaks: [{ start: "15:00", end: "15:30" }, { start: "13:00", end: "14:00" }] });
    assert.equal(set.breaks.length, 2);
    assert.equal((await call(db, ctx, getResourceBreaks, { resourceId: r.id })).breaks.length, 2);
    await rejectsWith(call(db, ctx, setResourceBreaks, { resourceId: r.id, breaks: [{ start: "13:00", end: "14:00" }, { start: "13:30", end: "15:00" }] }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, setResourceBreaks, { resourceId: r.id, breaks: [{ start: "14:00", end: "13:00" }] }), "VALIDATION_FAILED");
    assert.equal((await call(db, ctx, setResourceBreaks, { resourceId: r.id, breaks: [] })).breaks.length, 0);
    assert.equal((await call(db, ctx, getResourceBreaks, { resourceId: r.id })).breaks.length, 0);
  });
});

describe("which services a resource can serve", () => {
  test("by default the required resource type decides; an explicit link overrides it", async () => {
    const t = await db.createTenant("res-svc");
    const ctx = makeCtx(t);
    const cut = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Haircut", amountPaise: 1000, durationMinutes: 30, requiredResourceType: "staff" });
    const massage = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Massage", amountPaise: 1000, durationMinutes: 60, requiredResourceType: "staff" });
    const any = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Consult", amountPaise: 1000, durationMinutes: 15 });
    const stylist = await call(db, ctx, createResource, staff("Stylist") as never);
    const therapist = await call(db, ctx, createResource, staff("Therapist") as never);
    const room = await call(db, ctx, createResource, { type: "room", name: "Room 1" });

    const names = async (serviceId: string) => (await call(db, ctx, listResourcesForService, { serviceId })).map((r) => r.name);
    assert.deepEqual(await names(cut.id), ["Stylist", "Therapist"]);
    assert.deepEqual(await names(any.id), ["Room 1", "Stylist", "Therapist"], "no required type: every resource");

    const linked = await call(db, ctx, setResourceServices, { resourceId: therapist.id, serviceIds: [massage.id] });
    assert.deepEqual(linked.serviceIds, [massage.id]);
    assert.deepEqual(await names(cut.id), ["Stylist"], "a resource linked to other services drops out");
    assert.deepEqual(await names(massage.id), ["Stylist", "Therapist"]);
    await call(db, ctx, setResourceServices, { resourceId: room.id, serviceIds: [massage.id] });
    assert.deepEqual(await names(massage.id), ["Room 1", "Stylist", "Therapist"], "an explicit link beats the type rule");
    assert.deepEqual((await call(db, ctx, listResources, { serviceId: cut.id })).items.map((r) => r.name), ["Stylist"]);

    const cleared = await call(db, ctx, setResourceServices, { resourceId: therapist.id, serviceIds: [] });
    assert.deepEqual(cleared.serviceIds, []);
    assert.deepEqual(await names(cut.id), ["Stylist", "Therapist"]);
    assert.ok(stylist.id);
  });

  test("links must be live services of this tenant; archived and inactive resources are not offered", async () => {
    const t = await db.createTenant("res-svc-bad");
    const ta = await db.createTenant("res-svc-bad-o");
    const ctx = makeCtx(t);
    const svc = await call(db, ctx, createCatalogueItem, { kind: "service", name: "S", amountPaise: 1, durationMinutes: 10, requiredResourceType: "staff" });
    const prod = await call(db, ctx, createCatalogueItem, { kind: "product", name: "P", amountPaise: 1 });
    const foreign = await call(db, makeCtx(ta), createCatalogueItem, { kind: "service", name: "F", amountPaise: 1, durationMinutes: 10 });
    const r = await call(db, ctx, createResource, staff("R") as never);
    for (const bad of [prod.id, foreign.id, ghost]) await rejectsWith(call(db, ctx, setResourceServices, { resourceId: r.id, serviceIds: [bad] }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, setResourceServices, { resourceId: r.id, serviceIds: [svc.id, "not-a-uuid"] }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, setResourceServices, { resourceId: r.id, serviceIds: [svc.id], tenantId: t } as never), "VALIDATION_FAILED");
    await call(db, ctx, archiveCatalogueItem, { itemId: svc.id });
    await rejectsWith(call(db, ctx, setResourceServices, { resourceId: r.id, serviceIds: [svc.id] }), "NOT_FOUND");

    const svc2 = await call(db, ctx, createCatalogueItem, { kind: "service", name: "S2", amountPaise: 1, durationMinutes: 10, requiredResourceType: "staff" });
    const inactive = await call(db, ctx, createResource, staff("Inactive", { active: false }) as never);
    const gone = await call(db, ctx, createResource, staff("Gone") as never);
    await call(db, ctx, archiveResource, { resourceId: gone.id });
    const offered = (await call(db, ctx, listResourcesForService, { serviceId: svc2.id })).map((x) => x.name);
    assert.deepEqual(offered, ["R"]);
    assert.ok(inactive.id);
  });
});

describe("listing", () => {
  test("filters by type, location and name; pages by name", async () => {
    const t = await db.createTenant("res-list");
    const ctx = makeCtx(t);
    const l1 = await call(db, ctx, createLocation, { name: "L1" });
    const l2 = await call(db, ctx, createLocation, { name: "L2" });
    for (const [i, n] of ["delta", "Alpha", "charlie", "Bravo", "echo"].entries()) {
      await call(db, ctx, createResource, { type: i % 2 ? "room" : "staff", name: n, locationId: i < 3 ? l1.id : l2.id });
    }
    const names = async (q: Record<string, unknown>) => (await call(db, ctx, listResources, q as never)).items.map((r) => r.name);
    assert.deepEqual(await names({}), ["Alpha", "Bravo", "charlie", "delta", "echo"]);
    assert.deepEqual(await names({ type: "room" }), ["Alpha", "Bravo"]);
    assert.deepEqual(await names({ locationId: l2.id }), ["Bravo", "echo"]);
    assert.deepEqual(await names({ query: "LTA" }), ["delta"]);
    assert.deepEqual(await names({ query: "%" }), []);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, listResources, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...p.items.map((r) => r.name));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ["Alpha", "Bravo", "charlie", "delta", "echo"]);
    await rejectsWith(call(db, ctx, listResources, { type: "boat" } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, listResources, { cursor: "x" }), "VALIDATION_FAILED");
  });
});

describe("tenant isolation", () => {
  test("tenant A cannot read, change, schedule, time off, link or list tenant B's resources", async () => {
    const ta = await db.createTenant("res-iso-a");
    const tb = await db.createTenant("res-iso-b");
    const ctxA = makeCtx(ta);
    const ctxB = makeCtx(tb);
    const locB = await call(db, ctxB, createLocation, { name: "B loc" });
    const resB = await call(db, ctxB, createResource, staff("B staff", { locationId: locB.id }) as never);
    const svcB = await call(db, ctxB, createCatalogueItem, { kind: "service", name: "B svc", amountPaise: 1, durationMinutes: 10 });
    await call(db, ctxB, setResourceSchedule, { resourceId: resB.id, hours: week({ mon: [["09:00", "17:00"]] }) } as never);
    const off = await call(db, ctxB, addResourceTimeOff, { resourceId: resB.id, startsAt: "2031-03-01T00:00:00Z", endsAt: "2031-03-02T00:00:00Z" });
    const resA = await call(db, ctxA, createResource, staff("A staff") as never);

    await rejectsWith(call(db, ctxA, getResource, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateResource, { resourceId: resB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, archiveResource, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, restoreResource, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, getResourceSchedule, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, setResourceSchedule, { resourceId: resB.id, hours: week({}) } as never), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, getResourceBreaks, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, setResourceBreaks, { resourceId: resB.id, breaks: [] }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, listResourceTimeOff, { resourceId: resB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, addResourceTimeOff, { resourceId: resB.id, startsAt: "2031-04-01T00:00:00Z", endsAt: "2031-04-02T00:00:00Z" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, removeResourceTimeOff, { resourceId: resB.id, timeOffId: off.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, setResourceServices, { resourceId: resB.id, serviceIds: [] }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, setResourceServices, { resourceId: resA.id, serviceIds: [svcB.id] }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, listResourcesForService, { serviceId: svcB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, createResource, staff("planted", { locationId: locB.id }) as never), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateResource, { resourceId: resA.id, locationId: locB.id }), "NOT_FOUND");
    assert.deepEqual((await call(db, ctxA, listResources, { archived: "include" })).items.map((r) => r.name), ["A staff"]);
    assert.deepEqual((await call(db, ctxA, listResources, { serviceId: svcB.id }).catch(() => ({ items: [] }))).items, []);

    // B untouched
    assert.equal((await call(db, ctxB, getResource, { resourceId: resB.id })).name, "B staff");
    assert.deepEqual((await call(db, ctxB, getResourceSchedule, { resourceId: resB.id })).hours.mon, [{ start: "09:00", end: "17:00" }]);
    assert.equal((await call(db, ctxB, listResourceTimeOff, { resourceId: resB.id })).length, 1);
  });
});
