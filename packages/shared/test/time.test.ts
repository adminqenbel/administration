import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  eachLocalDate,
  generateSlots,
  hmToMinutes,
  isValidLocalDate,
  isValidTimezone,
  localDateOf,
  localToUtcMs,
  overlapsAny,
  tzOffsetMs,
  weekdayOf,
  weeklyHoursSchema,
  type TimeInterval,
  type WeeklyHours,
} from "../src/index.ts";

const closed: TimeInterval[] = [];
function week(overrides: Partial<WeeklyHours>): WeeklyHours {
  return { mon: closed, tue: closed, wed: closed, thu: closed, fri: closed, sat: closed, sun: closed, ...overrides };
}
const iso = (ms: number) => new Date(ms).toISOString();
const starts = (slots: { start: string }[]) => slots.map((s) => s.start);

// ---- basics -----------------------------------------------------------

test("timezone and date validation", () => {
  assert.ok(isValidTimezone("Asia/Kolkata"));
  assert.ok(isValidTimezone("America/New_York"));
  assert.ok(isValidTimezone("UTC"));
  for (const bad of ["", "Mars/Olympus", "EST", "+05:30", "asia/nowhere", 5, null]) assert.equal(isValidTimezone(bad), false, String(bad));
  assert.ok(isValidLocalDate("2024-02-29"));
  assert.equal(isValidLocalDate("2026-02-29"), false);
  assert.equal(isValidLocalDate("2026-13-01"), false);
  assert.equal(isValidLocalDate("26-1-1"), false);
});

test("weekday, addDays, eachLocalDate", () => {
  assert.equal(weekdayOf("2026-11-09"), "mon");
  assert.equal(weekdayOf("2026-11-08"), "sun");
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.deepEqual(eachLocalDate("2026-11-29", "2026-12-02"), ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
});

test("offsets: Kolkata is fixed, New York changes", () => {
  assert.equal(tzOffsetMs(Date.parse("2026-06-01T00:00:00Z"), "Asia/Kolkata"), 5.5 * 3_600_000);
  assert.equal(tzOffsetMs(Date.parse("2026-12-01T00:00:00Z"), "Asia/Kolkata"), 5.5 * 3_600_000);
  assert.equal(tzOffsetMs(Date.parse("2026-01-15T12:00:00Z"), "America/New_York"), -5 * 3_600_000);
  assert.equal(tzOffsetMs(Date.parse("2026-07-15T12:00:00Z"), "America/New_York"), -4 * 3_600_000);
});

test("localDateOf uses the zone, not UTC", () => {
  const t = Date.parse("2026-11-09T20:00:00Z"); // 01:30 next day in Kolkata
  assert.equal(localDateOf(t, "Asia/Kolkata"), "2026-11-10");
  assert.equal(localDateOf(t, "America/New_York"), "2026-11-09");
});

test("weeklyHoursSchema rejects overlaps and bad times", () => {
  const ok = week({ mon: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "18:00" }] });
  assert.ok(weeklyHoursSchema.safeParse(ok).success);
  assert.ok(weeklyHoursSchema.safeParse(week({ mon: [{ start: "09:00", end: "24:00" }] })).success);
  assert.ok(!weeklyHoursSchema.safeParse(week({ mon: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "18:00" }] })).success);
  assert.ok(!weeklyHoursSchema.safeParse(week({ mon: [{ start: "13:00", end: "09:00" }] })).success);
  assert.ok(!weeklyHoursSchema.safeParse(week({ mon: [{ start: "9:00", end: "13:00" }] })).success);
  assert.ok(!weeklyHoursSchema.safeParse({ ...ok, xyz: [] }).success);
  assert.equal(hmToMinutes("24:00"), 1440);
});

// ---- localToUtcMs -----------------------------------------------------

test("localToUtcMs: Kolkata has no DST", () => {
  assert.equal(iso(localToUtcMs("2026-11-09", 10 * 60, "Asia/Kolkata")), "2026-11-09T04:30:00.000Z");
  assert.equal(iso(localToUtcMs("2026-06-09", 10 * 60, "Asia/Kolkata")), "2026-06-09T04:30:00.000Z");
  assert.equal(iso(localToUtcMs("2026-11-09", 1440, "Asia/Kolkata")), "2026-11-09T18:30:00.000Z");
});

test("localToUtcMs: New York gap and fold", () => {
  // Spring forward 2026-03-08: 02:00 -> 03:00. 02:30 does not exist.
  assert.equal(iso(localToUtcMs("2026-03-08", 2 * 60 + 30, "America/New_York")), "2026-03-08T07:30:00.000Z"); // 03:30 EDT
  assert.equal(iso(localToUtcMs("2026-03-08", 60 + 59, "America/New_York")), "2026-03-08T06:59:00.000Z"); // 01:59 EST
  assert.equal(iso(localToUtcMs("2026-03-08", 3 * 60, "America/New_York")), "2026-03-08T07:00:00.000Z");
  // Fall back 2026-11-01: 01:00-02:00 happens twice. Earlier instant (EDT) wins.
  assert.equal(iso(localToUtcMs("2026-11-01", 60 + 30, "America/New_York")), "2026-11-01T05:30:00.000Z");
  assert.equal(iso(localToUtcMs("2026-11-01", 2 * 60, "America/New_York")), "2026-11-01T07:00:00.000Z"); // 02:00 EST
  assert.equal(iso(localToUtcMs("2026-11-01", 0, "America/New_York")), "2026-11-01T04:00:00.000Z");
});

test("localToUtcMs round trips through localDateOf in several zones", () => {
  for (const tz of ["Asia/Kolkata", "America/New_York", "Europe/London", "Australia/Sydney", "Pacific/Auckland"]) {
    for (const date of ["2026-01-10", "2026-03-29", "2026-04-05", "2026-10-25", "2026-11-01"]) {
      const ms = localToUtcMs(date, 12 * 60, tz);
      assert.equal(localDateOf(ms, tz), date, `${tz} ${date}`);
    }
  }
});

// ---- generateSlots: Asia/Kolkata -------------------------------------

const KOL = "Asia/Kolkata";

test("Kolkata: slots for a plain day", () => {
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09", // Monday
    hours: week({ mon: [{ start: "10:00", end: "12:00" }] }),
    durationMinutes: 30,
    stepMinutes: 30,
  });
  assert.deepEqual(starts(slots), [
    "2026-11-09T04:30:00.000Z",
    "2026-11-09T05:00:00.000Z",
    "2026-11-09T05:30:00.000Z",
    "2026-11-09T06:00:00.000Z",
  ]);
  assert.equal(slots[3]?.end, "2026-11-09T06:30:00.000Z");
});

test("closed weekday gives no slots", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  assert.deepEqual(generateSlots({ timezone: KOL, date: "2026-11-10", hours, durationMinutes: 30 }), []);
});

test("duration longer than the window gives none; exact fit gives one", () => {
  const hours = week({ mon: [{ start: "10:00", end: "11:00" }] });
  assert.equal(generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 90 }).length, 0);
  assert.equal(generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 60 }).length, 1);
});

test("step is independent of duration, anchored at the interval start", () => {
  const hours = week({ mon: [{ start: "10:00", end: "11:30" }] });
  const slots = generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 60, stepMinutes: 15 });
  assert.deepEqual(starts(slots), ["2026-11-09T04:30:00.000Z", "2026-11-09T04:45:00.000Z", "2026-11-09T05:00:00.000Z"]);
});

test("default step is 15 minutes", () => {
  const hours = week({ mon: [{ start: "10:00", end: "11:00" }] });
  assert.equal(generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 30 }).length, 3);
});

test("two opening intervals are both used", () => {
  const hours = week({ mon: [{ start: "09:00", end: "10:00" }, { start: "16:00", end: "17:00" }] });
  const slots = generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.deepEqual(starts(slots), ["2026-11-09T03:30:00.000Z", "2026-11-09T10:30:00.000Z"]);
});

test("holidays close the whole day; other days unaffected", () => {
  const hours = week({ mon: [{ start: "10:00", end: "11:00" }] });
  const base = { timezone: KOL, hours, durationMinutes: 30 };
  assert.deepEqual(generateSlots({ ...base, date: "2026-11-09", holidays: ["2026-11-09"] }), []);
  assert.equal(generateSlots({ ...base, date: "2026-11-09", holidays: ["2026-11-16"] }).length, 3);
});

test("breaks remove overlapping slots but keep the grid", () => {
  const hours = week({ mon: [{ start: "10:00", end: "14:00" }] });
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09",
    hours,
    breaks: [{ start: "12:00", end: "13:00" }],
    durationMinutes: 60,
    stepMinutes: 30,
  });
  // 10:00, 10:30, 11:00 (ends at 12:00 exactly, fine), then 13:00. 11:30 overlaps the break.
  const local = slots.map((s) => new Date(Date.parse(s.start) + 5.5 * 3_600_000).toISOString().slice(11, 16));
  assert.deepEqual(local, ["10:00", "10:30", "11:00", "13:00"]);
});

test("existing allocations block overlapping slots; touching ends are fine", () => {
  const hours = week({ mon: [{ start: "10:00", end: "13:00" }] });
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09",
    hours,
    durationMinutes: 60,
    stepMinutes: 60,
    // 11:00-12:00 local booked
    allocations: [{ start: "2026-11-09T05:30:00.000Z", end: "2026-11-09T06:30:00.000Z" }],
  });
  assert.deepEqual(starts(slots), ["2026-11-09T04:30:00.000Z", "2026-11-09T06:30:00.000Z"]);
});

test("partially overlapping and enclosing bookings both block", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  const common = { timezone: KOL, date: "2026-11-09", hours, durationMinutes: 30, stepMinutes: 30 };
  // booking 10:15-10:45 blocks 10:00 and 10:30
  const a = generateSlots({ ...common, allocations: [{ start: "2026-11-09T04:45:00.000Z", end: "2026-11-09T05:15:00.000Z" }] });
  assert.deepEqual(starts(a), ["2026-11-09T05:30:00.000Z", "2026-11-09T06:00:00.000Z"]);
  // booking covering the whole day blocks everything
  const b = generateSlots({ ...common, allocations: [{ start: "2026-11-09T00:00:00.000Z", end: "2026-11-09T23:00:00.000Z" }] });
  assert.deepEqual(b, []);
});

test("overlapping existing bookings (double allocations) still only block once", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09",
    hours,
    durationMinutes: 60,
    stepMinutes: 60,
    allocations: [
      { start: "2026-11-09T04:30:00.000Z", end: "2026-11-09T05:30:00.000Z" },
      { start: "2026-11-09T05:00:00.000Z", end: "2026-11-09T05:45:00.000Z" },
    ],
  });
  assert.deepEqual(slots, []);
});

test("buffer pads after each booking and before the next, but need not fit in opening hours", () => {
  const hours = week({ mon: [{ start: "10:00", end: "13:00" }] });
  const common = { timezone: KOL, date: "2026-11-09", hours, durationMinutes: 60, stepMinutes: 30, bufferMinutes: 15 };
  // booking 11:00-12:00 local: slots must end by 10:45 or start at/after 12:15 (grid: 12:30)
  const slots = generateSlots({ ...common, allocations: [{ start: "2026-11-09T05:30:00.000Z", end: "2026-11-09T06:30:00.000Z" }] });
  const local = slots.map((s) => new Date(Date.parse(s.start) + 5.5 * 3_600_000).toISOString().slice(11, 16));
  // 10:00 slot ends 11:00 + buffer 15 overlaps booking start -> blocked. 12:00 blocked by trailing buffer. 12:30 doesn't fit window.
  assert.deepEqual(local, []);
  // Without a booking, the last slot may end exactly at closing even though the buffer spills past it.
  const free = generateSlots({ ...common, stepMinutes: 60 });
  assert.equal(free.length, 3);
  assert.equal(free[2]?.end, "2026-11-09T07:30:00.000Z"); // 13:00 local
});

test("buffer zero allows back-to-back", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09",
    hours,
    durationMinutes: 60,
    stepMinutes: 60,
    allocations: [{ start: "2026-11-09T04:30:00.000Z", end: "2026-11-09T05:30:00.000Z" }],
  });
  assert.deepEqual(starts(slots), ["2026-11-09T05:30:00.000Z"]);
});

test("notBefore drops earlier slots (lead time)", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  const slots = generateSlots({
    timezone: KOL,
    date: "2026-11-09",
    hours,
    durationMinutes: 60,
    stepMinutes: 30,
    notBefore: "2026-11-09T05:00:00.000Z",
  });
  assert.deepEqual(starts(slots), ["2026-11-09T05:00:00.000Z", "2026-11-09T05:30:00.000Z"]);
});

test("generateSlots is pure and does not mutate input", () => {
  const input = {
    timezone: KOL,
    date: "2026-11-09",
    hours: week({ mon: [{ start: "10:00", end: "12:00" }] }),
    allocations: [{ start: "2026-11-09T05:30:00.000Z", end: "2026-11-09T06:30:00.000Z" }],
    durationMinutes: 30,
  };
  const before = JSON.stringify(input);
  const a = generateSlots(input);
  const b = generateSlots(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), before);
});

test("slots are sorted, unique and exactly durationMinutes long", () => {
  const hours = week({ mon: [{ start: "08:00", end: "20:00" }] });
  const slots = generateSlots({ timezone: KOL, date: "2026-11-09", hours, durationMinutes: 45, stepMinutes: 15, bufferMinutes: 10 });
  const ms = slots.map((s) => Date.parse(s.start));
  assert.deepEqual([...ms].sort((x, y) => x - y), ms);
  assert.equal(new Set(ms).size, ms.length);
  for (const s of slots) assert.equal(Date.parse(s.end) - Date.parse(s.start), 45 * 60_000);
});

test("invalid inputs throw VALIDATION_FAILED", () => {
  const hours = week({ mon: [{ start: "10:00", end: "12:00" }] });
  const ok = { timezone: KOL, date: "2026-11-09", hours, durationMinutes: 30 };
  for (const bad of [
    { ...ok, timezone: "Nope/Zone" },
    { ...ok, date: "2026-02-30" },
    { ...ok, durationMinutes: 0 },
    { ...ok, durationMinutes: 1.5 },
    { ...ok, stepMinutes: 0 },
    { ...ok, bufferMinutes: -1 },
    { ...ok, allocations: [{ start: "garbage", end: "garbage" }] },
  ]) {
    assert.throws(() => generateSlots(bad), (e: unknown) => (e as { code?: string }).code === "VALIDATION_FAILED");
  }
});

// ---- generateSlots: DST zone -----------------------------------------

const NY = "America/New_York";

test("New York, ordinary day around the DST change: 09:00-17:00 EDT after spring forward", () => {
  const hours = week({ mon: [{ start: "09:00", end: "17:00" }] });
  const slots = generateSlots({ timezone: NY, date: "2026-03-09", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.equal(slots.length, 8);
  assert.equal(slots[0]?.start, "2026-03-09T13:00:00.000Z"); // EDT = UTC-4
  // Same hours before the change: EST = UTC-5
  const before = generateSlots({ timezone: NY, date: "2026-03-02", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.equal(before[0]?.start, "2026-03-02T14:00:00.000Z");
});

test("New York, spring forward day is 23 hours long", () => {
  // 2026-03-08 is a Sunday. 00:00 EST to 06:00 EDT is five real hours.
  const hours = week({ sun: [{ start: "00:00", end: "06:00" }] });
  const slots = generateSlots({ timezone: NY, date: "2026-03-08", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.deepEqual(starts(slots), [
    "2026-03-08T05:00:00.000Z",
    "2026-03-08T06:00:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-03-08T08:00:00.000Z",
    "2026-03-08T09:00:00.000Z",
  ]);
  assert.equal(slots[4]?.end, "2026-03-08T10:00:00.000Z");
  for (const s of slots) assert.equal(Date.parse(s.end) - Date.parse(s.start), 3_600_000);
});

test("New York, fall back day is 25 hours long", () => {
  // 2026-11-01 is a Sunday. 00:00 EDT to 06:00 EST is seven real hours.
  const hours = week({ sun: [{ start: "00:00", end: "06:00" }] });
  const slots = generateSlots({ timezone: NY, date: "2026-11-01", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.equal(slots.length, 7);
  assert.equal(slots[0]?.start, "2026-11-01T04:00:00.000Z");
  assert.equal(slots[6]?.end, "2026-11-01T11:00:00.000Z");
  // No overlaps, contiguous
  for (let i = 1; i < slots.length; i++) assert.equal(slots[i]?.start, slots[i - 1]?.end);
});

test("New York: a booking in the repeated hour blocks only its own instants", () => {
  const hours = week({ sun: [{ start: "00:00", end: "04:00" }] });
  const slots = generateSlots({
    timezone: NY,
    date: "2026-11-01",
    hours,
    durationMinutes: 60,
    stepMinutes: 60,
    // 05:00Z-06:00Z is the first 01:00 (EDT). 06:00Z-07:00Z is the second 01:00 (EST).
    allocations: [{ start: "2026-11-01T05:00:00.000Z", end: "2026-11-01T06:00:00.000Z" }],
  });
  const s = starts(slots);
  assert.ok(!s.includes("2026-11-01T05:00:00.000Z"));
  assert.ok(s.includes("2026-11-01T06:00:00.000Z"));
});

test("New York: breaks and holidays use local wall time on a DST day", () => {
  const hours = week({ sun: [{ start: "00:00", end: "06:00" }] });
  const slots = generateSlots({
    timezone: NY,
    date: "2026-03-08",
    hours,
    breaks: [{ start: "03:00", end: "04:00" }], // 07:00Z-08:00Z
    durationMinutes: 60,
    stepMinutes: 60,
  });
  assert.deepEqual(starts(slots), ["2026-03-08T05:00:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-08T09:00:00.000Z"]);
  assert.deepEqual(generateSlots({ timezone: NY, date: "2026-03-08", hours, holidays: ["2026-03-08"], durationMinutes: 60 }), []);
});

test("Sydney (southern hemisphere DST) first Sunday of October", () => {
  // 2026-10-04: 02:00 AEST -> 03:00 AEDT. 00:00 to 06:00 is five real hours.
  const hours = week({ sun: [{ start: "00:00", end: "06:00" }] });
  const slots = generateSlots({ timezone: "Australia/Sydney", date: "2026-10-04", hours, durationMinutes: 60, stepMinutes: 60 });
  assert.equal(slots.length, 5);
});

// ---- overlapsAny -----------------------------------------------------

test("overlapsAny with and without buffer", () => {
  const ranges = [{ start: "2026-11-09T05:00:00.000Z", end: "2026-11-09T06:00:00.000Z" }];
  assert.equal(overlapsAny("2026-11-09T06:00:00.000Z", "2026-11-09T07:00:00.000Z", ranges), false);
  assert.equal(overlapsAny("2026-11-09T05:59:00.000Z", "2026-11-09T07:00:00.000Z", ranges), true);
  assert.equal(overlapsAny("2026-11-09T06:00:00.000Z", "2026-11-09T07:00:00.000Z", ranges, 10), true);
  assert.equal(overlapsAny("2026-11-09T06:10:00.000Z", "2026-11-09T07:00:00.000Z", ranges, 10), false);
  assert.equal(overlapsAny("2026-11-09T01:00:00.000Z", "2026-11-09T05:00:00.000Z", ranges), false);
});
