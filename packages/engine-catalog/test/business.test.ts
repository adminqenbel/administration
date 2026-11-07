import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveLocation, breaksOf, createCustomer, createHoliday, createLocation, deleteHoliday, getBusinessProfile, getBusinessProfileForChannel,
  getLocation, getLocationHours, listHolidays, listLocations, restoreLocation, setLocationHours, updateBusinessProfile, updateHoliday,
  updateLocation,
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

describe("locations", () => {
  test("time zone defaults to the business's, the first location is the default, a new default replaces it", async () => {
    const t = await db.createTenant("biz-loc");
    const ctx = makeCtx(t);
    const a = await call(db, ctx, createLocation, { name: "Main", address: { line1: "1 Road", city: "Pune" }, phone: "98765 43210", email: "Main@Example.com" });
    assert.equal(a.timezone, "Asia/Kolkata");
    assert.equal(a.isDefault, true);
    assert.equal(a.phone, "+919876543210");
    assert.equal(a.email, "main@example.com");
    assert.deepEqual(a.address, { line1: "1 Road", city: "Pune" });
    const b = await call(db, ctx, createLocation, { name: "Dubai", timezone: "Asia/Dubai" });
    assert.equal(b.isDefault, false);
    assert.equal(b.timezone, "Asia/Dubai");
    const c = await call(db, ctx, createLocation, { name: "Third", isDefault: true });
    assert.equal(c.isDefault, true);
    const list = await call(db, ctx, listLocations, {});
    assert.deepEqual(list.map((l) => l.name), ["Third", "Dubai", "Main"]);
    assert.equal(list.filter((l) => l.isDefault).length, 1);
    const moved = await call(db, ctx, updateLocation, { locationId: a.id, isDefault: true });
    assert.equal(moved.isDefault, true);
    assert.equal((await call(db, ctx, listLocations, {})).filter((l) => l.isDefault).length, 1);
  });

  test("invalid time zones, phones, addresses and unknown keys are refused", async () => {
    const t = await db.createTenant("biz-loc-bad");
    const ctx = makeCtx(t);
    for (const timezone of ["Mars/Olympus", "IST", "", "UTC+5", "Asia/Kolkata; drop table"]) {
      await rejectsWith(call(db, ctx, createLocation, { name: "X", timezone }), "VALIDATION_FAILED");
    }
    await rejectsWith(call(db, ctx, createLocation, { name: "X", phone: "12" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createLocation, { name: "X", address: { planet: "Mars" } } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createLocation, { name: "X", tenantId: t } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createLocation, { name: "" }), "VALIDATION_FAILED");
    const l = await call(db, ctx, createLocation, { name: "Y" });
    await rejectsWith(call(db, ctx, updateLocation, { locationId: l.id }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateLocation, { locationId: l.id, isDefault: false } as never), "VALIDATION_FAILED");
    const u = await call(db, ctx, updateLocation, { locationId: l.id, timezone: "Europe/London", phone: null });
    assert.equal(u.timezone, "Europe/London");
  });

  test("archive: refused for the default location and while live bookings are still to come; restore brings it back", async () => {
    const t = await db.createTenant("biz-loc-archive");
    const ctx = makeCtx(t);
    const main = await call(db, ctx, createLocation, { name: "Main" });
    const branch = await call(db, ctx, createLocation, { name: "Branch" });
    await rejectsWith(call(db, ctx, archiveLocation, { locationId: main.id }), "CONFLICT");

    await tx(db, t, async (c) => {
      await insertBooking(c, t, { locationId: branch.id, from: at(600), to: at(660) });
      await insertBooking(c, t, { locationId: branch.id, from: at(700), to: at(760), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() + 600_000) });
      await insertBooking(c, t, { locationId: branch.id, from: at(800), to: at(860), status: "CANCELLED" });
    });
    const err = await rejectsWith(call(db, ctx, archiveLocation, { locationId: branch.id }), "CONFLICT");
    assert.equal(err.details.upcomingBookings, 2);

    // After they have all passed, archive works
    const later = makeCtx(t, { now: new Date(at(5000).getTime()) });
    const arch = await call(db, later, archiveLocation, { locationId: branch.id });
    assert.equal(arch.active, false);
    assert.deepEqual((await call(db, ctx, listLocations, {})).map((l) => l.name), ["Main"]);
    assert.equal((await call(db, ctx, listLocations, { includeArchived: true })).length, 2);
    await rejectsWith(call(db, ctx, updateLocation, { locationId: branch.id, isDefault: true }), "CONFLICT");
    assert.equal((await call(db, ctx, restoreLocation, { locationId: branch.id })).active, true);
    assert.equal((await call(db, later, archiveLocation, { locationId: branch.id })).active, false);
    assert.equal((await call(db, later, archiveLocation, { locationId: branch.id })).active, false, "idempotent");
  });
});

describe("weekly business hours and breaks", () => {
  test("set, read back, replace; intervals in one day leave a break; 24:00 closes a day", async () => {
    const t = await db.createTenant("biz-hours");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Main" });
    const hours = week({ mon: [["09:00", "13:00"], ["14:00", "18:00"]], tue: [["09:00", "18:00"]], sat: [["00:00", "24:00"]] });
    const set = await call(db, ctx, setLocationHours, { locationId: loc.id, hours } as never);
    assert.deepEqual(set.hours.mon, [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "18:00" }]);
    assert.deepEqual(set.hours.sat, [{ start: "00:00", end: "24:00" }]);
    assert.deepEqual(set.hours.sun, []);
    assert.deepEqual(set.breaks.mon, [{ start: "13:00", end: "14:00" }]);
    assert.deepEqual(set.breaks.tue, []);
    assert.equal(set.timezone, "Asia/Kolkata");
    const read = await call(db, ctx, getLocationHours, { locationId: loc.id });
    assert.deepEqual(read.hours, set.hours);

    const replaced = await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ wed: [["10:00", "16:00"]] }) } as never);
    assert.deepEqual(replaced.hours.mon, []);
    assert.deepEqual(replaced.hours.wed, [{ start: "10:00", end: "16:00" }]);
    const cleared = await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({}) } as never);
    assert.deepEqual(cleared.hours.wed, []);
  });

  test("overlapping, backwards, malformed and unknown-day hours are refused and change nothing", async () => {
    const t = await db.createTenant("biz-hours-bad");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Main" });
    await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ mon: [["09:00", "17:00"]] }) } as never);
    const bad: unknown[] = [
      week({ mon: [["09:00", "12:00"], ["11:00", "15:00"]] }),
      week({ mon: [["12:00", "09:00"]] }),
      week({ mon: [["9:00", "12:00"]] }),
      week({ mon: [["25:00", "26:00"]] }),
      { ...week({}), funday: [] },
      { mon: [] },
    ];
    for (const hours of bad) await rejectsWith(call(db, ctx, setLocationHours, { locationId: loc.id, hours } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({}), tenantId: t } as never), "VALIDATION_FAILED");
    assert.deepEqual((await call(db, ctx, getLocationHours, { locationId: loc.id })).hours.mon, [{ start: "09:00", end: "17:00" }]);
    await rejectsWith(call(db, ctx, setLocationHours, { locationId: ghost, hours: week({}) } as never), "NOT_FOUND");
  });

  test("breaksOf finds gaps only between consecutive intervals", () => {
    const b = breaksOf(week({ mon: [["09:00", "12:00"], ["12:00", "13:00"], ["15:00", "18:00"]] }) as never);
    assert.deepEqual(b.mon, [{ start: "13:00", end: "15:00" }]);
  });
});

describe("holidays", () => {
  test("closed days, special hours, per-location and all-location, one per location per date", async () => {
    const t = await db.createTenant("biz-hol");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Main" });
    const all = await call(db, ctx, createHoliday, { date: "2031-01-26", name: "Republic Day" });
    assert.equal(all.locationId, null);
    assert.equal(all.closed, true);
    assert.equal(all.openTime, null);
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "Dup" }), "CONFLICT");
    const own = await call(db, ctx, createHoliday, { locationId: loc.id, date: "2031-01-26", name: "Local" });
    assert.equal(own.locationId, loc.id);
    await rejectsWith(call(db, ctx, createHoliday, { locationId: loc.id, date: "2031-01-26", name: "Dup" }), "CONFLICT");
    const special = await call(db, ctx, createHoliday, { locationId: loc.id, date: "2031-03-14", name: "Half day", closed: false, openTime: "09:00", closeTime: "13:00" });
    assert.equal(special.closed, false);
    assert.equal(special.openTime, "09:00");
    assert.equal(special.closeTime, "13:00");
  });

  test("times must match the kind of day", async () => {
    const t = await db.createTenant("biz-hol-bad");
    const ctx = makeCtx(t);
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "x", openTime: "09:00", closeTime: "10:00" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "x", closed: false }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "x", closed: false, openTime: "10:00", closeTime: "09:00" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-02-30", name: "x" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createHoliday, { date: "26-01-2031", name: "x" }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "x", locationId: ghost }), "NOT_FOUND");
    await rejectsWith(call(db, ctx, createHoliday, { date: "2031-01-26", name: "x", tenantId: t } as never), "VALIDATION_FAILED");
  });

  test("update flips between closed and special hours; delete removes; list filters and pages", async () => {
    const t = await db.createTenant("biz-hol-list");
    const ctx = makeCtx(t);
    const l1 = await call(db, ctx, createLocation, { name: "One" });
    const l2 = await call(db, ctx, createLocation, { name: "Two" });
    const h = await call(db, ctx, createHoliday, { locationId: l1.id, date: "2031-05-01", name: "Labour Day" });
    const open = await call(db, ctx, updateHoliday, { holidayId: h.id, closed: false, openTime: "10:00", closeTime: "14:00" });
    assert.equal(open.closed, false);
    assert.equal(open.openTime, "10:00");
    const closed = await call(db, ctx, updateHoliday, { holidayId: h.id, closed: true });
    assert.equal(closed.closed, true);
    assert.equal(closed.openTime, null);
    await rejectsWith(call(db, ctx, updateHoliday, { holidayId: h.id, closed: false }), "VALIDATION_FAILED");
    await rejectsWith(call(db, ctx, updateHoliday, { holidayId: h.id }), "VALIDATION_FAILED");
    assert.equal((await call(db, ctx, updateHoliday, { holidayId: h.id, name: "Renamed" })).name, "Renamed");

    for (const d of ["2031-06-01", "2031-07-01", "2031-08-01", "2031-09-01"]) await call(db, ctx, createHoliday, { locationId: l2.id, date: d, name: d });
    await call(db, ctx, createHoliday, { date: "2031-10-01", name: "Everyone" });
    const forL1 = await call(db, ctx, listHolidays, { locationId: l1.id });
    assert.deepEqual(forL1.items.map((i) => i.date), ["2031-05-01", "2031-10-01"]);
    const forL2 = await call(db, ctx, listHolidays, { locationId: l2.id, from: "2031-07-01", to: "2031-09-30" });
    assert.deepEqual(forL2.items.map((i) => i.date), ["2031-07-01", "2031-08-01", "2031-09-01"]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await call(db, ctx, listHolidays, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...p.items.map((i) => i.date));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, ["2031-05-01", "2031-06-01", "2031-07-01", "2031-08-01", "2031-09-01", "2031-10-01"]);
    assert.deepEqual(await call(db, ctx, deleteHoliday, { holidayId: h.id }), { deleted: true });
    await rejectsWith(call(db, ctx, deleteHoliday, { holidayId: h.id }), "NOT_FOUND");
  });
});

describe("business profile", () => {
  test("staff view reads settings with defaults and every location with its hours and breaks", async () => {
    const t = await db.createTenant("biz-profile");
    const ctx = makeCtx(t);
    const loc = await call(db, ctx, createLocation, { name: "Main" });
    await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ mon: [["09:00", "12:00"], ["13:00", "17:00"]] }) } as never);
    const p = await call(db, ctx, getBusinessProfile, undefined);
    assert.equal(p.packId, "salon");
    assert.equal(p.holdMinutes, 10);
    assert.deepEqual(p.requiredCustomerFields, ["name", "phone"]);
    assert.equal(p.locations.length, 1);
    assert.deepEqual(p.locations[0]!.breaks.mon, [{ start: "12:00", end: "13:00" }]);
  });

  test("update merges known settings, keeps unknown keys, rejects bad values; AI view never shows unknown keys", async () => {
    const t = await db.createTenant("biz-profile-upd");
    const ctx = makeCtx(t);
    await tx(db, t, (c) => c.query(`update tenants set settings = '{"integrationSecret":"s3cr3t-value","holdMinutes":"not a number"}'::jsonb where id = $1`, [t]));
    const upd = await call(db, ctx, updateBusinessProfile, {
      name: "Glow Salon", contact: { phone: "98765 43210", email: "Hello@Glow.example" },
      cancellationPolicy: { summary: "Free up to 4 hours before.", freeCancelHoursBefore: 4 }, holdMinutes: 15, requiredCustomerFields: ["name", "phone", "email"],
      extraQuestions: [{ field: "allergies", label: "Any allergies?", required: false }],
    });
    assert.equal(upd.name, "Glow Salon");
    assert.equal(upd.holdMinutes, 15);
    assert.deepEqual(upd.contact, { phone: "+919876543210", email: "hello@glow.example" });
    const raw = await tx(db, t, async (c) => (await c.query<{ settings: Record<string, unknown> }>("select settings from tenants where id = $1", [t])).rows[0]!.settings);
    assert.equal(raw.integrationSecret, "s3cr3t-value", "keys this engine does not own are preserved");

    const loc = await call(db, ctx, createLocation, { name: "Main", address: { line1: "1 Road", city: "Pune", postalCode: "411001" } });
    const arch = await call(db, ctx, createLocation, { name: "Closed branch", address: { line1: "Hidden St" } });
    await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ mon: [["09:00", "17:00"]], sun: [["10:00", "14:00"]] }) } as never);
    await call(db, makeCtx(t, { now: new Date(at(9000).getTime()) }), archiveLocation, { locationId: arch.id });

    const ai = await call(db, ctx, getBusinessProfileForChannel, undefined);
    assert.equal(ai.businessName, "Glow Salon");
    assert.equal(ai.locations.length, 1, "archived locations are hidden");
    assert.equal(ai.locations[0]!.address, "1 Road, Pune, 411001");
    assert.deepEqual(ai.hours, [{ dayOfWeek: 0, opens: "10:00", closes: "14:00" }, { dayOfWeek: 1, opens: "09:00", closes: "17:00" }]);
    assert.equal(ai.cancellationPolicy.freeCancelHoursBefore, 4);
    const wire = JSON.stringify(ai);
    for (const secret of ["s3cr3t-value", "integrationSecret", "Hidden St", "Closed branch", t]) assert.ok(!wire.includes(secret), `AI profile must not contain "${secret}"`);
    assert.deepEqual(Object.keys(ai).sort(), ["businessName", "cancellationPolicy", "contact", "currency", "extraQuestions", "holdMinutes", "hours", "locations", "packId", "requiredCustomerFields", "timezone"]);

    for (const bad of [{ holdMinutes: 0 }, { holdMinutes: 241 }, { requiredCustomerFields: ["shoe size"] }, { contact: { phone: "12" } }, { defaultTimezone: "Nowhere/Land" }, { name: "" }, { currency: "rupees" }, {}, { packId: "clinic" }, { tenantId: t }]) {
      await rejectsWith(call(db, ctx, updateBusinessProfile, bad as never), "VALIDATION_FAILED");
    }
  });

  test("unreadable stored settings fall back to defaults instead of failing", async () => {
    const t = await db.createTenant("biz-profile-corrupt");
    await tx(db, t, (c) => c.query(`update tenants set settings = '{"contact":"oops","cancellationPolicy":[1],"requiredCustomerFields":["name","bogus"]}'::jsonb where id = $1`, [t]));
    const p = await call(db, makeCtx(t), getBusinessProfileForChannel, undefined);
    assert.deepEqual(p.contact, {});
    assert.deepEqual(p.requiredCustomerFields, ["name", "phone"]);
  });

  test("a tenant's context reads and edits only its own business row", async () => {
    const ta = await db.createTenant("biz-iso-a");
    const tb = await db.createTenant("biz-iso-b");
    await call(db, makeCtx(ta), updateBusinessProfile, { name: "Alpha Business" });
    const b = await call(db, makeCtx(tb), getBusinessProfile, undefined);
    assert.notEqual(b.name, "Alpha Business");
    // client scoped to B, context claims A: B's row is invisible under A's id
    await assert.rejects(tx(db, tb, (c) => getBusinessProfile(c, makeCtx(ta))), (e: { code?: string }) => e.code === "NOT_FOUND");
  });
});

describe("tenant isolation", () => {
  test("tenant A cannot see, change or use tenant B's locations, hours or holidays", async () => {
    const ta = await db.createTenant("biz-xt-a");
    const tb = await db.createTenant("biz-xt-b");
    const ctxA = makeCtx(ta);
    const ctxB = makeCtx(tb);
    const locB = await call(db, ctxB, createLocation, { name: "B Location" });
    await call(db, ctxB, setLocationHours, { locationId: locB.id, hours: week({ mon: [["09:00", "17:00"]] }) } as never);
    const holB = await call(db, ctxB, createHoliday, { locationId: locB.id, date: "2031-01-26", name: "B holiday" });

    await rejectsWith(call(db, ctxA, getLocation, { locationId: locB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateLocation, { locationId: locB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, archiveLocation, { locationId: locB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, restoreLocation, { locationId: locB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, getLocationHours, { locationId: locB.id }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, setLocationHours, { locationId: locB.id, hours: week({}) } as never), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, createHoliday, { locationId: locB.id, date: "2031-02-02", name: "planted" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, updateHoliday, { holidayId: holB.id, name: "hijack" }), "NOT_FOUND");
    await rejectsWith(call(db, ctxA, deleteHoliday, { holidayId: holB.id }), "NOT_FOUND");
    assert.deepEqual(await call(db, ctxA, listLocations, { includeArchived: true }), []);
    assert.deepEqual((await call(db, ctxA, listHolidays, {})).items, []);
    assert.deepEqual((await call(db, ctxA, listHolidays, { locationId: locB.id })).items, []);

    const still = await call(db, ctxB, getLocationHours, { locationId: locB.id });
    assert.deepEqual(still.hours.mon, [{ start: "09:00", end: "17:00" }]);
    assert.equal((await call(db, ctxB, listHolidays, {})).items.length, 1);
    assert.equal((await call(db, ctxB, getLocation, { locationId: locB.id })).name, "B Location");
  });

  test("customers.created events and locations stay in their own tenant", async () => {
    const ta = await db.createTenant("biz-ev-a");
    const tb = await db.createTenant("biz-ev-b");
    await call(db, makeCtx(ta), createCustomer, { name: "Only A" });
    const evB = await tx(db, tb, async (c) => (await c.query("select 1 from outbox_events")).rows.length);
    assert.equal(evB, 0);
  });
});
