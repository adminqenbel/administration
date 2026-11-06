// Pure, IANA timezone aware time helpers and slot generation.
// All instants are epoch milliseconds internally and ISO 8601 UTC strings on the wire.
// Local dates are "YYYY-MM-DD", local times are "HH:MM" in the location timezone.
import { z } from "zod";
import { AppError, ErrorCode } from "./errors.ts";

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// ---- schemas -------------------------------------------------------------

export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.includes("/") || tz === "UTC";
  } catch {
    return false;
  }
}

export const timezoneSchema = z.string().refine(isValidTimezone, "Not a valid IANA timezone");

export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Calendar date, "YYYY-MM-DD". */
export const localDateSchema = z.string().refine(isValidLocalDate, "Expected a date as YYYY-MM-DD");

/** Local time of day, "HH:MM", 00:00 to 23:59. */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a time as HH:MM");

/** Interval end may be "24:00" (end of day). */
const localTimeEndSchema = z.union([localTimeSchema, z.literal("24:00")]);

/** ISO 8601 instant. Offsets are accepted and normalised by consumers. */
export const instantSchema = z.iso.datetime({ offset: true });

export function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export const timeIntervalSchema = z
  .object({ start: localTimeSchema, end: localTimeEndSchema })
  .strict()
  .refine((i) => hmToMinutes(i.start) < hmToMinutes(i.end), "end must be after start");
export type TimeInterval = z.infer<typeof timeIntervalSchema>;

const dayIntervalsSchema = z.array(timeIntervalSchema).superRefine((list, ctx) => {
  const sorted = [...list].sort((a, b) => hmToMinutes(a.start) - hmToMinutes(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (hmToMinutes((sorted[i] as TimeInterval).start) < hmToMinutes((sorted[i - 1] as TimeInterval).end)) {
      ctx.addIssue({ code: "custom", message: "intervals must not overlap" });
      return;
    }
  }
});

/** Opening hours per weekday. An empty list means closed. */
export const weeklyHoursSchema = z
  .object({
    mon: dayIntervalsSchema,
    tue: dayIntervalsSchema,
    wed: dayIntervalsSchema,
    thu: dayIntervalsSchema,
    fri: dayIntervalsSchema,
    sat: dayIntervalsSchema,
    sun: dayIntervalsSchema,
  })
  .strict();
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

// ---- timezone arithmetic -------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

function assertTz(tz: string): void {
  if (!isValidTimezone(tz)) throw new AppError(ErrorCode.VALIDATION_FAILED, "Invalid timezone", { timezone: tz });
}

/** Wall clock fields of an instant in `tz`. */
export function localParts(ms: number, tz: string) {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (local minus UTC). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** Local calendar date of an instant, "YYYY-MM-DD". */
export function localDateOf(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function weekdayOf(localDate: string): Weekday {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as Weekday;
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function dateToDayNumber(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). Both must be valid local dates. */
export function daysBetween(from: string, to: string): number {
  if (!isValidLocalDate(from) || !isValidLocalDate(to)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Invalid date");
  }
  return dateToDayNumber(to) - dateToDayNumber(from);
}

const MAX_DATE_RANGE_DAYS = 3660;

/** Inclusive list of local dates from `from` to `to`. Empty if `to` is before `from`. */
export function eachLocalDate(from: string, to: string): string[] {
  const span = daysBetween(from, to);
  if (span > MAX_DATE_RANGE_DAYS) throw new AppError(ErrorCode.VALIDATION_FAILED, "Date range is too long");
  const out: string[] = [];
  for (let i = 0; i <= span; i++) out.push(addDays(from, i));
  return out;
}

/**
 * Local date and minute-of-day in `tz` to a UTC instant.
 * Ambiguous times (clocks go back) resolve to the earlier instant.
 * Non-existent times (clocks go forward) resolve to the same wall time on the pre-change offset,
 * which lands just after the gap.
 * `minutes` may be 1440 (end of day).
 */
export function localToUtcMs(localDate: string, minutes: number, tz: string): number {
  assertTz(tz);
  if (!isValidLocalDate(localDate)) throw new AppError(ErrorCode.VALIDATION_FAILED, "Invalid date");
  const [y, m, d] = localDate.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d) + minutes * MS_MIN;
  const before = tzOffsetMs(wall - MS_DAY, tz);
  const after = tzOffsetMs(wall + MS_DAY, tz);
  const valid: number[] = [];
  for (const offset of new Set([before, after])) {
    const candidate = wall - offset;
    if (tzOffsetMs(candidate, tz) === offset) valid.push(candidate);
  }
  if (valid.length > 0) return Math.min(...valid);
  return wall - before;
}

// ---- slot generation -----------------------------------------------------

export interface TimeRange {
  /** ISO 8601 UTC instant. */
  start: string;
  /** ISO 8601 UTC instant, exclusive. */
  end: string;
}

export interface SlotRequest {
  timezone: string;
  /** Local date to generate for. */
  date: string;
  hours: WeeklyHours;
  /** Daily breaks, local time. Slots may not overlap a break. */
  breaks?: readonly TimeInterval[];
  /** Local dates the business is closed all day. */
  holidays?: readonly string[];
  /** Existing active allocations (bookings and live holds) for this resource. */
  allocations?: readonly TimeRange[];
  /** Service time in minutes. */
  durationMinutes: number;
  /** Cleanup time after each booking. Blocks the following slot but need not fit inside opening hours. */
  bufferMinutes?: number;
  /** Distance between slot starts, anchored to each opening interval start. Default 15. */
  stepMinutes?: number;
  /** Slots starting before this instant are dropped (lead time, "now"). */
  notBefore?: string;
}

export const DEFAULT_STEP_MINUTES = 15;

function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new AppError(ErrorCode.VALIDATION_FAILED, "Invalid instant");
  return ms;
}

function positiveInt(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `${name} must be an integer of at least ${min}`);
  }
}

/**
 * Slots for one resource on one local date. Pure: the same input gives the same output.
 * A slot is the service time only; it must sit inside one opening interval, avoid breaks,
 * and keep clear of existing allocations plus the buffer.
 * Steps are real elapsed time, so on a DST change day the number of slots reflects the
 * actual length of the day.
 */
export function generateSlots(req: SlotRequest): TimeRange[] {
  assertTz(req.timezone);
  if (!isValidLocalDate(req.date)) throw new AppError(ErrorCode.VALIDATION_FAILED, "Invalid date");
  const duration = req.durationMinutes;
  const buffer = req.bufferMinutes ?? 0;
  const step = req.stepMinutes ?? DEFAULT_STEP_MINUTES;
  positiveInt(duration, "durationMinutes", 1);
  positiveInt(step, "stepMinutes", 1);
  positiveInt(buffer, "bufferMinutes", 0);

  if (req.holidays?.includes(req.date)) return [];

  const intervals = req.hours[weekdayOf(req.date)] ?? [];
  const durMs = duration * MS_MIN;
  const stepMs = step * MS_MIN;
  const bufMs = buffer * MS_MIN;
  const notBefore = req.notBefore === undefined ? -Infinity : toMs(req.notBefore);

  const breaks = (req.breaks ?? []).map((b) => ({
    start: localToUtcMs(req.date, hmToMinutes(b.start), req.timezone),
    end: localToUtcMs(req.date, hmToMinutes(b.end), req.timezone),
  }));
  const busy = (req.allocations ?? []).map((a) => ({ start: toMs(a.start), end: toMs(a.end) }));

  const slots: TimeRange[] = [];
  for (const interval of intervals) {
    const winStart = localToUtcMs(req.date, hmToMinutes(interval.start), req.timezone);
    const winEnd = localToUtcMs(req.date, hmToMinutes(interval.end), req.timezone);
    for (let s = winStart; s + durMs <= winEnd; s += stepMs) {
      const e = s + durMs;
      if (s < notBefore) continue;
      if (breaks.some((b) => s < b.end && b.start < e)) continue;
      if (busy.some((a) => s < a.end + bufMs && a.start < e + bufMs)) continue;
      slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
    }
  }
  return slots;
}

/** True when [start, end) overlaps any range, with `bufferMinutes` of clearance after each range. */
export function overlapsAny(start: string, end: string, ranges: readonly TimeRange[], bufferMinutes = 0): boolean {
  const s = toMs(start);
  const e = toMs(end);
  const buf = bufferMinutes * MS_MIN;
  return ranges.some((r) => s < toMs(r.end) + buf && toMs(r.start) < e + buf);
}
