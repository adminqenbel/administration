// The tables behind resource time off, weekly breaks and service links (migration 013): what the engine writes, how rows
// are read back, tenant isolation, half-open overlap semantics, and that the old `attributes` keys mean nothing now.
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateSlots, type WeeklyHours } from "@qenbel/shared";
import {
  addResourceTimeOff, archiveResource, createCatalogueItem, createLocation, createResource, generateResourceSlots, getResource, getResourceBreaks,
  listResources, listResourceTimeOff, listResourcesForService, loadAvailabilityInputs, removeResourceTimeOff, setLocationHours, setResourceBreaks,
  setResourceServices, slotRequestFor, updateResource,
} from "../src/index.ts";
import { NOW, at, call, connectTestDb, insertBooking, makeCtx, rejectsWith, tx, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

const MON = "2031-01-06";
const week = (days: Record<string, Array<[string, string]>>) => {
  const w: Record<string, Array<{ start: string; end: string }>> = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
  for (const [d, list] of Object.entries(days)) w[d] = list.map(([start, end]) => ({ start, end }));
  return w as unknown as WeeklyHours;
};
const ist = (date: string, hm: string): Date => new Date(`${date}T${hm}:00+05:30`);
const hmIst = (iso: string): string => new Date(Date.parse(iso) + 19_800_000).toISOString().slice(11, 16);

async function rows<T extends Record<string, unknown>>(tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return tx(db, tenantId, async (c) => (await c.query<T>(sql, [tenantId, ...params])).rows);
}

async function rawRows<T extends Record<string, unknown>>(tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return tx(db, tenantId, async (c) => (await c.query<T>(sql, params)).rows);
}

async function setup(prefix: string) {
  const t = await db.createTenant(prefix);
  const ctx = makeCtx(t);
  const loc = await call(db, ctx, createLocation, { name: "Main" });
  await call(db, ctx, setLocationHours, { locationId: loc.id, hours: week({ mon: [["09:00", "18:00"]], tue: [["09:00", "18:00"]], wed: [["09:00", "18:00"]] }) } as never);
  const svc = await call(db, ctx, createCatalogueItem, { kind: "service", name: "Cut", amountPaise: 1000, durationMinutes: 30, requiredResourceType: "staff" });
  const a = await call(db, ctx, createResource, { type: "staff", name: "Asha", locationId: loc.id });
  const b = await call(db, ctx, createResource, { type: "staff", name: "Bala", locationId: loc.id });
  return { t, ctx, loc: loc.id, svc: svc.id, a: a.id, b: b.id };
}

describe("resource_time_off", () => {
  test("rows hold the interval, reason and the recording user; list overlap is half-open", async () => {
    const w = await setup("rt-off");
    const user = await tx(db, w.t, async (c) => {
      const r = await c.query<{ id: string }>(
        "insert into users (tenant_id, auth_provider, external_subject, name, role) values ($1, 'dev', $2, 'Manager', 'MANAGER') returning id",
        [w.t, `dev|${randomUUID()}`],
      );
      return (r.rows[0] as { id: string }).id;
    });
    const staffCtx = makeCtx(w.t, { kind: "user" as never, actorId: user });
    const off = await call(db, staffCtx, addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z", reason: "Leave" });
    assert.equal(off.createdByUserId, user);
    assert.equal(off.reason, "Leave");
    const stored = await rows<{ id: string; starts_at: Date; ends_at: Date; reason: string; created_by_user_id: string }>(
      w.t, "select id, starts_at, ends_at, reason, created_by_user_id from resource_time_off where tenant_id = $1",
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.id, off.id);
    assert.equal(stored[0]!.created_by_user_id, user);

    // a system actor and a made-up actor id are not recorded as a user
    const sys = await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-02T10:00:00Z", endsAt: "2031-03-02T11:00:00Z" });
    assert.equal(sys.createdByUserId, null);
    const fake = await call(db, makeCtx(w.t, { kind: "user" as never, actorId: randomUUID() }), addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-03T10:00:00Z", endsAt: "2031-03-03T11:00:00Z" });
    assert.equal(fake.createdByUserId, null);

    // [10:00, 12:00) against windows: ends_at > from and starts_at < to
    const win = async (from: string, to: string) => (await call(db, w.ctx, listResourceTimeOff, { resourceId: w.a, from, to })).filter((o) => o.id === off.id).length;
    assert.equal(await win("2031-03-01T12:00:00Z", "2031-03-01T13:00:00Z"), 0, "window starting exactly when it ends does not overlap");
    assert.equal(await win("2031-03-01T09:00:00Z", "2031-03-01T10:00:00Z"), 0, "window ending exactly when it starts does not overlap");
    assert.equal(await win("2031-03-01T11:59:59Z", "2031-03-01T13:00:00Z"), 1);
    assert.equal(await win("2031-03-01T09:00:00Z", "2031-03-01T10:00:01Z"), 1);
    assert.equal(await win("2031-03-01T10:30:00Z", "2031-03-01T11:00:00Z"), 1, "a window inside the entry overlaps");
    assert.equal(await win("2031-03-01T00:00:00Z", "2031-03-02T00:00:00Z"), 1, "a window containing the entry overlaps");
    const only = await call(db, w.ctx, listResourceTimeOff, { resourceId: w.a, from: "2031-03-02T00:00:00Z" });
    assert.deepEqual(only.map((o) => o.id), [sys.id, fake.id].sort((x, y) => (x === sys.id ? -1 : 1)));
  });

  test("exact duplicates are a CONFLICT, back-to-back and overlapping entries are allowed, reason is capped at 500", async () => {
    const w = await setup("rt-dup");
    const base = { resourceId: w.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z" };
    await call(db, w.ctx, addResourceTimeOff, base);
    await rejectsWith(call(db, w.ctx, addResourceTimeOff, base), "CONFLICT");
    await call(db, w.ctx, addResourceTimeOff, { ...base, startsAt: "2031-03-01T12:00:00Z", endsAt: "2031-03-01T14:00:00Z" });
    await call(db, w.ctx, addResourceTimeOff, { ...base, startsAt: "2031-03-01T11:00:00Z", endsAt: "2031-03-01T13:00:00Z" });
    assert.equal((await call(db, w.ctx, listResourceTimeOff, { resourceId: w.a })).length, 3);
    const long = "r".repeat(500);
    assert.equal((await call(db, w.ctx, addResourceTimeOff, { ...base, startsAt: "2031-04-01T10:00:00Z", endsAt: "2031-04-01T11:00:00Z", reason: long })).reason, long);
    await rejectsWith(call(db, w.ctx, addResourceTimeOff, { ...base, startsAt: "2031-04-02T10:00:00Z", endsAt: "2031-04-02T11:00:00Z", reason: "r".repeat(501) }), "VALIDATION_FAILED");
  });

  test("a booking that starts when the time off ends (or ends when it starts) does not block it; one second of overlap does", async () => {
    const w = await setup("rt-edge");
    await tx(db, w.t, (c) => insertBooking(c, w.t, { resourceId: w.a, from: at(600), to: at(660) }));
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: at(660).toISOString(), endsAt: at(720).toISOString() });
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: at(540).toISOString(), endsAt: at(600).toISOString() });
    const err = await rejectsWith(call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: at(659.98).toISOString(), endsAt: at(720).toISOString() }), "CONFLICT");
    assert.equal(err.details.affectedBookings, 1);
  });

  test("remove deletes only that resource's row; unknown, foreign or other-resource ids are NOT_FOUND", async () => {
    const w = await setup("rt-rm");
    const other = await setup("rt-rm-o");
    const off = await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z" });
    const theirs = await call(db, other.ctx, addResourceTimeOff, { resourceId: other.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z" });
    await rejectsWith(call(db, w.ctx, removeResourceTimeOff, { resourceId: w.b, timeOffId: off.id }), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, removeResourceTimeOff, { resourceId: w.a, timeOffId: theirs.id }), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, removeResourceTimeOff, { resourceId: w.a, timeOffId: randomUUID() }), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, removeResourceTimeOff, { resourceId: w.a, timeOffId: "not-an-id" }), "VALIDATION_FAILED");
    assert.deepEqual(await call(db, w.ctx, removeResourceTimeOff, { resourceId: w.a, timeOffId: off.id }), { deleted: true });
    assert.equal((await rows(other.t, "select 1 from resource_time_off where tenant_id = $1")).length, 1, "the other tenant's row is untouched");
  });

  test("the loader uses the same overlap rule at the window edges", async () => {
    const w = await setup("rt-window");
    const dayStart = ist(MON, "00:00");
    const dayEnd = ist("2031-01-07", "00:00");
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: new Date(dayStart.getTime() - 3600_000).toISOString(), endsAt: dayStart.toISOString() }); // ends exactly at window start
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.b, startsAt: dayEnd.toISOString(), endsAt: new Date(dayEnd.getTime() + 3600_000).toISOString() }); // starts exactly at window end
    let inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.svc, from: MON });
    for (const r of inputs.resources) assert.deepEqual(r.timeOff, [], `${r.name}: touching the window is not overlapping`);
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: new Date(dayStart.getTime() - 3600_000).toISOString(), endsAt: new Date(dayStart.getTime() + 1000).toISOString() });
    inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.svc, from: MON });
    assert.equal(inputs.resources.find((r) => r.resourceId === w.a)!.timeOff.length, 1);
  });

  test("tenant isolation: the other tenant's resource and rows are invisible and unwritable", async () => {
    const a = await setup("rt-iso-a");
    const b = await setup("rt-iso-b");
    const off = await call(db, b.ctx, addResourceTimeOff, { resourceId: b.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z", reason: "private" });
    await rejectsWith(call(db, a.ctx, listResourceTimeOff, { resourceId: b.a }), "NOT_FOUND");
    await rejectsWith(call(db, a.ctx, addResourceTimeOff, { resourceId: b.a, startsAt: "2031-04-01T10:00:00Z", endsAt: "2031-04-01T12:00:00Z" }), "NOT_FOUND");
    await rejectsWith(call(db, a.ctx, removeResourceTimeOff, { resourceId: b.a, timeOffId: off.id }), "NOT_FOUND");
    // a client scoped to A sees none of B's rows at all, whatever the SQL says
    assert.deepEqual(await rawRows(a.t, "select id from resource_time_off"), []);
    assert.deepEqual(await rawRows(a.t, "select id from resource_time_off where resource_id = $1", [b.a]), []);
    // and B's time off never reaches A's availability, nor A's resources B's
    const inputs = await call(db, a.ctx, loadAvailabilityInputs, { locationId: a.loc, serviceId: a.svc, from: "2031-03-01" });
    for (const r of inputs.resources) assert.deepEqual(r.timeOff, []);
    assert.equal((await call(db, b.ctx, listResourceTimeOff, { resourceId: b.a })).length, 1);
  });
});

describe("resource_breaks", () => {
  test("a daily break is seven rows; read back as the same break on every weekday", async () => {
    const w = await setup("rb-daily");
    const set = await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [{ start: "13:00", end: "14:00" }, { start: "16:00", end: "16:15" }] });
    assert.equal(set.hasBreaks, true);
    assert.deepEqual(set.breaks, [{ start: "13:00", end: "14:00" }, { start: "16:00", end: "16:15" }]);
    const stored = await rows<{ weekday: number; c: string }>(w.t, "select weekday, count(*) as c from resource_breaks where tenant_id = $1 and resource_id = $2 group by weekday order by weekday", [w.a]);
    assert.deepEqual(stored.map((r) => [r.weekday, Number(r.c)]), [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 2]));
    const got = await call(db, w.ctx, getResourceBreaks, { resourceId: w.a });
    for (const d of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const) assert.deepEqual(got.weekly[d], set.breaks);
    // replacing leaves no stale rows; the other resource is untouched; clearing removes every row
    await call(db, w.ctx, setResourceBreaks, { resourceId: w.b, breaks: [{ start: "12:00", end: "12:30" }] });
    await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [{ start: "10:00", end: "10:10" }] });
    assert.equal((await rows(w.t, "select 1 from resource_breaks where tenant_id = $1 and resource_id = $2", [w.a])).length, 7);
    const cleared = await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [] });
    assert.equal(cleared.hasBreaks, false);
    assert.deepEqual(cleared.breaks, []);
    assert.equal((await rows(w.t, "select 1 from resource_breaks where tenant_id = $1 and resource_id = $2", [w.a])).length, 0);
    assert.equal((await rows(w.t, "select 1 from resource_breaks where tenant_id = $1 and resource_id = $2", [w.b])).length, 7);
  });

  test("a weekly pattern differs by weekday; `breaks` shows only what applies every day; generateSlots gets the day's own breaks", async () => {
    const w = await setup("rb-weekly");
    const set = await call(db, w.ctx, setResourceBreaks, {
      resourceId: w.a,
      weekly: week({ mon: [["12:00", "13:00"]], tue: [["12:00", "13:00"], ["15:00", "15:30"]], wed: [["10:00", "10:30"]], sun: [["12:00", "13:00"]] }),
    });
    assert.equal(set.hasBreaks, true);
    assert.deepEqual(set.weekly.mon, [{ start: "12:00", end: "13:00" }]);
    assert.deepEqual(set.weekly.tue, [{ start: "12:00", end: "13:00" }, { start: "15:00", end: "15:30" }]);
    assert.deepEqual(set.weekly.thu, []);
    assert.deepEqual(set.breaks, [], "no break is common to all seven days");
    const stored = await rows<{ weekday: number }>(w.t, "select weekday from resource_breaks where tenant_id = $1 and resource_id = $2 order by weekday, start_time", [w.a]);
    assert.deepEqual(stored.map((r) => r.weekday), [0, 1, 2, 2, 3]);

    const inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.svc, from: MON, to: "2031-01-08" }); // Mon..Wed
    const r = inputs.resources.find((x) => x.resourceId === w.a)!;
    assert.equal(r.hasOwnBreaks, true);
    assert.deepEqual(r.breaks.tue, set.weekly.tue);
    const starts = (date: string) => generateResourceSlots(inputs, r, date, { stepMinutes: 30 }).map((s) => hmIst(s.start));
    assert.ok(!starts("2031-01-06").includes("12:00") && !starts("2031-01-06").includes("12:30") && starts("2031-01-06").includes("10:00"), "Monday: lunch only");
    assert.ok(!starts("2031-01-07").includes("15:00") && !starts("2031-01-07").includes("12:30"), "Tuesday: lunch and a tea break");
    assert.ok(!starts("2031-01-08").includes("10:00") && starts("2031-01-08").includes("12:00"), "Wednesday: only the 10:00 break");
    // the request handed to generateSlots carries just that weekday's breaks
    assert.deepEqual(slotRequestFor(inputs, r, "2031-01-07").breaks, set.weekly.tue);
    assert.ok(generateSlots(slotRequestFor(inputs, r, "2031-01-06", { stepMinutes: 30 })).every((s) => hmIst(s.start) !== "12:00"));
    // the resource without rows is unaffected
    const other = inputs.resources.find((x) => x.resourceId === w.b)!;
    assert.equal(other.hasOwnBreaks, false);
    assert.ok(generateResourceSlots(inputs, other, "2031-01-06", { stepMinutes: 30 }).some((s) => hmIst(s.start) === "12:00"));
  });

  test("bad input: overlap, backwards, both or neither form, more than 10 a day, unknown keys, unknown resource", async () => {
    const w = await setup("rb-bad");
    const iv = (s: string, e: string) => ({ start: s, end: e });
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [iv("13:00", "14:00"), iv("13:30", "15:00")] }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [iv("14:00", "13:00")] }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, weekly: week({ mon: [["13:00", "14:00"], ["13:30", "15:00"]] }) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [], weekly: week({}) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: Array.from({ length: 11 }, (_, i) => iv(`0${i % 10}:00`, `0${i % 10}:10`)) }), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [], tenantId: w.t } as never), "VALIDATION_FAILED");
    await rejectsWith(call(db, w.ctx, setResourceBreaks, { resourceId: randomUUID(), breaks: [] }), "NOT_FOUND");
    assert.equal((await rows(w.t, "select 1 from resource_breaks where tenant_id = $1")).length, 0, "nothing was written");
  });

  test("tenant isolation", async () => {
    const a = await setup("rb-iso-a");
    const b = await setup("rb-iso-b");
    await call(db, b.ctx, setResourceBreaks, { resourceId: b.a, breaks: [{ start: "12:00", end: "13:00" }] });
    await rejectsWith(call(db, a.ctx, getResourceBreaks, { resourceId: b.a }), "NOT_FOUND");
    await rejectsWith(call(db, a.ctx, setResourceBreaks, { resourceId: b.a, breaks: [] }), "NOT_FOUND");
    assert.deepEqual(await rawRows(a.t, "select id from resource_breaks"), []);
    assert.equal((await call(db, b.ctx, getResourceBreaks, { resourceId: b.a })).hasBreaks, true);
  });
});

describe("resource_services", () => {
  test("links are rows; no rows means the required resource type decides; replacing and clearing leave no strays", async () => {
    const w = await setup("rs-links");
    const room = await call(db, w.ctx, createResource, { type: "room", name: "Room 1", locationId: w.loc });
    const svc2 = await call(db, w.ctx, createCatalogueItem, { kind: "service", name: "Colour", amountPaise: 2000, durationMinutes: 60, requiredResourceType: "staff" });
    const open = await call(db, w.ctx, listResourcesForService, { serviceId: w.svc });
    assert.deepEqual(open.map((r) => r.name), ["Asha", "Bala"], "type rule: staff only, the room is not eligible");

    const linked = await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [w.svc, w.svc.toUpperCase(), svc2.id] });
    assert.deepEqual([...linked.serviceIds].sort(), [w.svc, svc2.id].sort(), "duplicates collapse");
    assert.equal((await rows(w.t, "select 1 from resource_services where tenant_id = $1 and resource_id = $2", [w.a])).length, 2);
    // Asha is now limited to her links; Bala (no rows) still follows the type rule
    assert.deepEqual((await call(db, w.ctx, listResourcesForService, { serviceId: svc2.id })).map((r) => r.name), ["Asha", "Bala"]);
    await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [svc2.id] });
    assert.deepEqual((await call(db, w.ctx, listResourcesForService, { serviceId: w.svc })).map((r) => r.name), ["Bala"]);
    assert.equal((await call(db, w.ctx, getResource, { resourceId: w.a })).serviceIds.length, 1);
    // an explicit link beats the type rule: a room linked to a staff-type service is eligible
    await call(db, w.ctx, setResourceServices, { resourceId: room.id, serviceIds: [w.svc] });
    assert.deepEqual((await call(db, w.ctx, listResourcesForService, { serviceId: w.svc })).map((r) => r.name), ["Bala", "Room 1"]);
    // the same rule drives list filters and the availability loader
    assert.deepEqual((await call(db, w.ctx, listResources, { serviceId: w.svc })).items.map((r) => r.name), ["Bala", "Room 1"]);
    const inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.svc, from: MON });
    assert.deepEqual(inputs.resources.map((r) => r.name), ["Bala", "Room 1"]);
    // clearing returns to the type rule
    const cleared = await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [] });
    assert.deepEqual(cleared.serviceIds, []);
    assert.equal((await rows(w.t, "select 1 from resource_services where tenant_id = $1 and resource_id = $2", [w.a])).length, 0);
    assert.ok((await call(db, w.ctx, listResourcesForService, { serviceId: w.svc })).some((r) => r.name === "Asha"));
  });

  test("service links of many resources come back in one list without per-row queries", async () => {
    const w = await setup("rs-batch");
    await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [w.svc] });
    let queries = 0;
    const list = await tx(db, w.t, async (c) => {
      const spy = { query: ((text: string, values?: readonly unknown[]) => { queries++; return c.query(text, values as unknown[]); }) as typeof c.query };
      return listResources(spy as never, w.ctx, {});
    });
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items.find((r) => r.id === w.a)!.serviceIds, [w.svc]);
    assert.deepEqual(list.items.find((r) => r.id === w.b)!.serviceIds, []);
    assert.equal(queries, 2, "one for resources, one for all their links");
  });

  test("links to foreign services are refused; archiving the resource keeps its links", async () => {
    const w = await setup("rs-guard");
    const other = await setup("rs-guard-o");
    await rejectsWith(call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [other.svc] }), "NOT_FOUND");
    await rejectsWith(call(db, w.ctx, setResourceServices, { resourceId: other.a, serviceIds: [w.svc] }), "NOT_FOUND");
    await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [w.svc] });
    await call(db, w.ctx, archiveResource, { resourceId: w.a });
    assert.equal((await call(db, w.ctx, getResource, { resourceId: w.a })).serviceIds.length, 1);
    assert.deepEqual(await rawRows(other.t, "select id from resource_services"), []);
    assert.equal((await rows(w.t, "select 1 from resource_services where tenant_id = $1")).length, 1);
  });

  test("tenant isolation: another tenant's links never make a resource eligible or visible", async () => {
    const a = await setup("rs-iso-a");
    const b = await setup("rs-iso-b");
    await call(db, b.ctx, setResourceServices, { resourceId: b.a, serviceIds: [b.svc] });
    assert.deepEqual(await rawRows(a.t, "select id from resource_services"), []);
    assert.equal((await call(db, a.ctx, getResource, { resourceId: a.a })).serviceIds.length, 0);
    await rejectsWith(call(db, a.ctx, setResourceServices, { resourceId: b.a, serviceIds: [] }), "NOT_FOUND");
    await rejectsWith(call(db, a.ctx, listResourcesForService, { serviceId: b.svc }), "NOT_FOUND");
    assert.equal((await call(db, b.ctx, getResource, { resourceId: b.a })).serviceIds.length, 1);
  });
});

describe("the old attribute keys are ordinary attributes", () => {
  // Decision: `timeOff`, `breaks` and `serviceIds` are no longer reserved. They are plain scalar attribute keys like any
  // other (arrays and objects are refused because attributes are scalar-only), and the engine never reads them.
  test("setting them stores strings and numbers as plain attributes and changes nothing about availability or eligibility", async () => {
    const w = await setup("ra-plain");
    const smuggle = { timeOff: "all week", breaks: "12:00-13:00", serviceIds: "none" };
    const r = await call(db, w.ctx, updateResource, { resourceId: w.a, attributes: smuggle });
    assert.deepEqual(r.attributes, smuggle);
    assert.deepEqual(r.serviceIds, []);
    assert.deepEqual((await call(db, w.ctx, getResourceBreaks, { resourceId: w.a })).breaks, []);
    assert.deepEqual(await call(db, w.ctx, listResourceTimeOff, { resourceId: w.a }), []);
    const inputs = await call(db, w.ctx, loadAvailabilityInputs, { locationId: w.loc, serviceId: w.svc, from: MON });
    const a = inputs.resources.find((x) => x.resourceId === w.a)!;
    assert.deepEqual(a.timeOff, []);
    assert.equal(a.hasOwnBreaks, false);
    assert.equal(generateResourceSlots(inputs, a, MON, { stepMinutes: 30 }).length, 18);
    assert.ok(inputs.resources.some((x) => x.resourceId === w.a), "still eligible by type");
    // replacing attributes never touches the tables
    await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [{ start: "12:00", end: "13:00" }] });
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z" });
    await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [w.svc] });
    const replaced = await call(db, w.ctx, updateResource, { resourceId: w.a, attributes: { skill: "senior" } });
    assert.deepEqual(replaced.attributes, { skill: "senior" });
    assert.equal(replaced.serviceIds.length, 1);
    assert.equal((await call(db, w.ctx, getResourceBreaks, { resourceId: w.a })).hasBreaks, true);
    assert.equal((await call(db, w.ctx, listResourceTimeOff, { resourceId: w.a })).length, 1);
  });

  test("array or object values (the shape the interim storage used) are still refused", async () => {
    const w = await setup("ra-shape");
    for (const attributes of [{ timeOff: [{ start: "2031-03-01T00:00:00Z", end: "2031-03-02T00:00:00Z" }] }, { breaks: [{ start: "12:00", end: "13:00" }] }, { serviceIds: [w.svc] }]) {
      await rejectsWith(call(db, w.ctx, createResource, { type: "staff", name: "Sneaky", attributes } as never), "VALIDATION_FAILED");
      await rejectsWith(call(db, w.ctx, updateResource, { resourceId: w.a, attributes } as never), "VALIDATION_FAILED");
    }
    assert.deepEqual((await call(db, w.ctx, getResource, { resourceId: w.a })).attributes, {});
  });

  test("the engine never writes those keys into attributes", async () => {
    const w = await setup("ra-nowrite");
    await call(db, w.ctx, setResourceBreaks, { resourceId: w.a, breaks: [{ start: "12:00", end: "13:00" }] });
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: "2031-03-01T10:00:00Z", endsAt: "2031-03-01T12:00:00Z" });
    await call(db, w.ctx, setResourceServices, { resourceId: w.a, serviceIds: [w.svc] });
    const raw = await rows<{ attributes: Record<string, unknown> }>(w.t, "select attributes from resources where tenant_id = $1 and id = $2", [w.a]);
    assert.deepEqual(raw[0]!.attributes, {});
  });
});

describe("live bookings are still protected", () => {
  test("time off over a booking and archive over a booking are refused, with counts; NOW-relative holds that expired are ignored", async () => {
    const w = await setup("rl-guard");
    await tx(db, w.t, (c) => insertBooking(c, w.t, { resourceId: w.a, from: at(600), to: at(660) }));
    await tx(db, w.t, (c) => insertBooking(c, w.t, { resourceId: w.b, from: at(600), to: at(660), status: "HOLD", holdExpiresAt: new Date(NOW.getTime() - 1000) }));
    const off = await rejectsWith(call(db, w.ctx, addResourceTimeOff, { resourceId: w.a, startsAt: at(630).toISOString(), endsAt: at(700).toISOString() }), "CONFLICT");
    assert.equal(off.details.affectedBookings, 1);
    const arch = await rejectsWith(call(db, w.ctx, archiveResource, { resourceId: w.a }), "CONFLICT");
    assert.equal(arch.details.upcomingBookings, 1);
    assert.equal((await rows(w.t, "select 1 from resource_time_off where tenant_id = $1")).length, 0, "nothing was written");
    await call(db, w.ctx, addResourceTimeOff, { resourceId: w.b, startsAt: at(630).toISOString(), endsAt: at(700).toISOString() });
  });
});
