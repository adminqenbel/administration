// Pure slot computation for one resource. Uses generateSlots from @qenbel/shared for the calendar maths
// (opening intervals, breaks, DST-correct stepping, lead time). This file adds what generateSlots does not know:
// intersecting location hours with the resource's own pattern, holiday hours, time off, shared capacity.
import {
  AllocationMode,
  WEEKDAYS,
  generateSlots,
  hmToMinutes,
  weekdayOf,
  type TimeInterval,
  type TimeRange,
  type WeeklyHours,
} from "@qenbel/shared";
import type { AllocationRow, ResourceAvailabilityInputs } from "./availability-source.ts";

export interface SlotParams {
  durationMinutes: number;
  /** Cleanup time after a booking. Applies to exclusive resources only. */
  bufferMinutes: number;
  stepMinutes: number;
  /** Units a booking needs on a shared resource (seats). Default 1. */
  units?: number;
  /** Slots starting before this instant are dropped. */
  notBefore?: string | null;
  /** Dates after this local date are dropped (maximum advance). */
  lastDate?: string | null;
  /** Pack hours, used when the location has no hours configured. */
  defaultHours: WeeklyHours;
  /** Daily breaks used when the resource has no resource_breaks rows. */
  defaultBreaks: readonly TimeInterval[];
  /** Skip the allocation check (used to test "is this window open at all"). */
  ignoreAllocations?: boolean;
}

function minutesToHm(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Sort and merge touching or overlapping intervals. */
export function normaliseIntervals(list: readonly TimeInterval[]): TimeInterval[] {
  const sorted = list
    .map((i) => ({ s: hmToMinutes(i.start), e: hmToMinutes(i.end) }))
    .filter((i) => i.e > i.s)
    .sort((a, b) => a.s - b.s);
  const out: { s: number; e: number }[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.s <= last.e) last.e = Math.max(last.e, cur.e);
    else out.push({ ...cur });
  }
  return out.map((i) => ({ start: minutesToHm(i.s), end: minutesToHm(i.e) }));
}

export function intersectIntervals(a: readonly TimeInterval[], b: readonly TimeInterval[]): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const x of normaliseIntervals(a)) {
    for (const y of normaliseIntervals(b)) {
      const s = Math.max(hmToMinutes(x.start), hmToMinutes(y.start));
      const e = Math.min(hmToMinutes(x.end), hmToMinutes(y.end));
      if (e > s) out.push({ start: minutesToHm(s), end: minutesToHm(e) });
    }
  }
  return normaliseIntervals(out);
}

function weekdayIndex(date: string): number {
  return WEEKDAYS.indexOf(weekdayOf(date));
}

/** Opening intervals of one resource on one local date, in the location's local time. */
export function effectiveIntervals(
  inputs: ResourceAvailabilityInputs,
  date: string,
  defaultHours: WeeklyHours,
): TimeInterval[] {
  const holiday = inputs.holidays.find((h) => h.date === date);
  if (holiday?.closed) return [];

  const wd = weekdayIndex(date);
  let base: TimeInterval[];
  if (holiday && holiday.open !== null && holiday.close !== null) {
    base = [{ start: holiday.open, end: holiday.close }];
  } else if (inputs.businessHours.length > 0) {
    base = inputs.businessHours.filter((r) => r.weekday === wd).map((r) => ({ start: r.start, end: r.end }));
  } else {
    base = [...(defaultHours[weekdayOf(date)] ?? [])];
  }
  if (inputs.resourceHours.length === 0) return normaliseIntervals(base);

  const own = inputs.resourceHours
    .filter((r) => r.weekday === wd && (r.validFrom === null || r.validFrom <= date) && (r.validTo === null || date <= r.validTo))
    .map((r) => ({ start: r.start, end: r.end }));
  return intersectIntervals(base, own);
}

/** Highest number of units in use at any instant of [startMs, endMs). Matches the database trigger. */
export function peakUnits(allocations: readonly AllocationRow[], startMs: number, endMs: number): number {
  const rows = allocations.map((a) => ({ s: Date.parse(a.start), e: Date.parse(a.end), u: a.units }));
  const points = [startMs, ...rows.filter((r) => r.s > startMs && r.s < endMs).map((r) => r.s)];
  let peak = 0;
  for (const p of points) {
    let used = 0;
    for (const r of rows) if (r.s <= p && p < r.e) used += r.u;
    if (used > peak) peak = used;
  }
  return peak;
}

function emptyWeek(): WeeklyHours {
  return { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
}

/** Free slots for one resource over local dates (inclusive list). Pure. */
export function slotsForResource(
  inputs: ResourceAvailabilityInputs,
  dates: readonly string[],
  params: SlotParams,
): TimeRange[] {
  if (inputs.unreadable) return [];
  const { resource } = inputs;
  const exclusive = resource.allocationMode === AllocationMode.EXCLUSIVE;
  const buffer = exclusive ? params.bufferMinutes : 0;
  const bufferMs = buffer * 60_000;
  const units = params.units ?? 1;

  // Exclusive: the stored allocation already ends after its own buffer. Pull each start back by this booking's buffer
  // so a slot cannot end inside the cleanup window that must precede the next booking.
  const busy: TimeRange[] =
    params.ignoreAllocations === true || !exclusive
      ? []
      : inputs.allocations.map((a) => ({ start: new Date(Date.parse(a.start) - bufferMs).toISOString(), end: a.end }));
  const timeOff = inputs.timeOff.map((t) => ({ s: Date.parse(t.start), e: Date.parse(t.end) }));

  const out: TimeRange[] = [];
  for (const date of dates) {
    if (params.lastDate !== undefined && params.lastDate !== null && date > params.lastDate) continue;
    const intervals = effectiveIntervals(inputs, date, params.defaultHours);
    if (intervals.length === 0) continue;
    const hours = emptyWeek();
    hours[weekdayOf(date)] = intervals;
    const wd = weekdayIndex(date);
    const breaks: readonly TimeInterval[] =
      inputs.breaks === null
        ? params.defaultBreaks
        : inputs.breaks.filter((b) => b.weekday === wd).map((b) => ({ start: b.start, end: b.end }));
    const slots = generateSlots({
      timezone: resource.timezone,
      date,
      hours,
      breaks: [...breaks],
      holidays: [],
      allocations: busy,
      durationMinutes: params.durationMinutes,
      bufferMinutes: 0,
      stepMinutes: params.stepMinutes,
      ...(params.notBefore ? { notBefore: params.notBefore } : {}),
    });
    for (const slot of slots) {
      const s = Date.parse(slot.start);
      const e = Date.parse(slot.end);
      if (timeOff.some((t) => s < t.e && t.s < e)) continue;
      if (!exclusive && params.ignoreAllocations !== true) {
        if (units > resource.capacityUnits) continue;
        if (peakUnits(inputs.allocations, s, e) + units > resource.capacityUnits) continue;
      }
      out.push(slot);
    }
  }
  return out;
}
