// Availability inputs: everything the booking engine needs to run `generateSlots` from @qenbel/shared, read from the
// database in a few set-based queries (no per-resource round trips). Pure helpers at the bottom build the slot request
// and apply what generateSlots does not know about (time off, shared capacity).
import { z } from "zod";
import {
  AppError, CatalogueItemKind, ErrorCode, ResourceType, WEEKDAYS, addDays, daysBetween, eachLocalDate, generateSlots, hmToMinutes,
  localDateSchema, localToUtcMs, overlapsAny, weekdayOf,
  type SlotRequest, type TimeInterval, type TimeRange, type Weekday, type WeeklyHours,
} from "@qenbel/shared";
import { hm, idArg, notFound, op } from "./common.ts";
import { emptyWeek, readLocationHours, weekFromRows } from "./business.ts";
import { ELIGIBLE_SQL, loadWeeklyBreaks } from "./resources.ts";

export const MAX_AVAILABILITY_RANGE_DAYS = 31;
const MAX_RESOURCES = 200;

export interface AllocationRange extends TimeRange {
  /** Capacity units held (matters for shared resources). */
  units: number;
}

export interface ResourceAvailabilityInput {
  resourceId: string;
  name: string;
  type: string;
  allocationMode: "exclusive" | "shared";
  capacityUnits: number;
  minUnits: number;
  /**
   * Effective weekly opening pattern for this resource: the location's hours intersected with the resource's
   * schedule (a resource with no schedule follows the location). Gaps between a day's intervals are breaks.
   */
  hours: WeeklyHours;
  /** Local dates (inside the requested range) whose intervals differ from `hours`, with that day's effective intervals. */
  dateOverrides: Record<string, TimeInterval[]>;
  /**
   * The resource's own breaks per local weekday (resource_breaks). All seven days empty means the resource has no
   * break rows of its own (`hasOwnBreaks` false), so the caller's default breaks apply.
   */
  breaks: Record<Weekday, TimeInterval[]>;
  /** True when the resource has break rows (even if some weekdays have none). */
  hasOwnBreaks: boolean;
  /** Local dates closed all day (holidays for this location or for all locations). */
  holidays: string[];
  /** Time off overlapping the range, as UTC instants. generateSlots does not know about it: use `generateResourceSlots`. */
  timeOff: TimeRange[];
  /** Active allocations (bookings and live holds) near the range. Expired holds are not included. */
  allocations: AllocationRange[];
}

export interface AvailabilityInputs {
  timezone: string;
  locationId: string;
  /** First and last local date requested (inclusive). */
  from: string;
  to: string;
  /** UTC instants covering from 00:00 local to the end of `to` (end exclusive). */
  window: TimeRange;
  service: {
    id: string | null;
    name: string | null;
    variantId: string | null;
    durationMinutes: number;
    bufferMinutes: number;
  };
  resources: ResourceAvailabilityInput[];
}

const inputSchema = z
  .object({
    locationId: idArg,
    serviceId: idArg.optional(),
    variantId: idArg.optional(),
    /** Only without serviceId (for example a table booking): length of the booking. */
    durationMinutes: z.number().int().min(1).max(1440).optional(),
    bufferMinutes: z.number().int().min(0).max(1440).optional(),
    resourceIds: z.array(idArg).min(1).max(100).optional(),
    resourceType: z.enum(Object.values(ResourceType) as [string, ...string[]]).optional(),
    /** Seats or units needed. Filters out resources too small (or, for exclusive ones, too big for min_units). */
    partySize: z.number().int().min(1).max(10_000).optional(),
    from: localDateSchema,
    to: localDateSchema.optional(),
    /** Ignore this booking's own allocations (reschedule). */
    excludeBookingId: idArg.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.serviceId === undefined && v.durationMinutes === undefined) {
      ctx.addIssue({ code: "custom", path: ["serviceId"], message: "Give serviceId, or durationMinutes" });
    }
    if (v.serviceId !== undefined && (v.durationMinutes !== undefined || v.bufferMinutes !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "Duration and buffer come from the service" });
    }
    if (v.variantId !== undefined && v.serviceId === undefined) {
      ctx.addIssue({ code: "custom", path: ["variantId"], message: "variantId needs serviceId" });
    }
    const to = v.to ?? v.from;
    if (localDateSchema.safeParse(v.from).success && localDateSchema.safeParse(to).success) {
      const span = daysBetween(v.from, to);
      if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "to must not be before from" });
      else if (span + 1 > MAX_AVAILABILITY_RANGE_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: `Range is at most ${MAX_AVAILABILITY_RANGE_DAYS} days` });
    }
  });

// ---- interval maths (minutes) ------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");
const minToHm = (m: number): string => (m >= 1440 ? "24:00" : `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`);

export function intersectIntervals(a: readonly TimeInterval[], b: readonly TimeInterval[]): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(hmToMinutes(x.start), hmToMinutes(y.start));
      const e = Math.min(hmToMinutes(x.end), hmToMinutes(y.end));
      if (s < e) out.push({ start: minToHm(s), end: minToHm(e) });
    }
  }
  return out.sort((p, q) => hmToMinutes(p.start) - hmToMinutes(q.start));
}

const sameIntervals = (a: readonly TimeInterval[], b: readonly TimeInterval[]): boolean =>
  a.length === b.length && a.every((x, i) => x.start === (b[i] as TimeInterval).start && x.end === (b[i] as TimeInterval).end);

// ---- loader ------------------------------------------------------------------------------------------

interface ScheduleRow {
  resource_id: string;
  weekday: number;
  s: string;
  e: string;
  vf: string | null;
  vt: string | null;
}

interface HolidayRow {
  location_id: string | null;
  d: string;
  closed: boolean;
  o: string | null;
  c: string | null;
}

interface AllocationRow {
  resource_id: string;
  s: Date;
  e: Date;
  units: number;
}

/**
 * Read the pure inputs for slot generation. One call covers all candidate resources and the whole date range.
 *
 * Candidate resources: not archived, active, at this location (or with no location), eligible for the service
 * (explicit link, else required resource type), within `resourceIds` if given, and big enough for `partySize`.
 * A resource that does not qualify is simply absent from `resources`.
 *
 * Time off, breaks, holidays and existing allocations are read here; nothing is decided here. Use
 * `generateResourceSlots` (below) or build a `SlotRequest` with `slotRequestFor` and call `generateSlots` yourself.
 */
export const loadAvailabilityInputs = op(inputSchema, async (sql, ctx, input): Promise<AvailabilityInputs> => {
  const from = input.from;
  const to = input.to ?? input.from;

  // location
  const loc = await sql.query<{ timezone: string; active: boolean }>("select timezone, active from locations where tenant_id = $1 and id = $2", [ctx.tenantId, input.locationId]);
  const location = loc.rows[0];
  if (!location || !location.active) throw notFound("Location");
  const tz = location.timezone;

  // service
  let service: AvailabilityInputs["service"];
  if (input.serviceId) {
    const it = await sql.query<{ kind: string; name: string; duration_minutes: number | null; buffer_minutes: number; available: boolean; archived_at: Date | null }>(
      "select kind, name, duration_minutes, buffer_minutes, available, archived_at from catalogue_items where tenant_id = $1 and id = $2",
      [ctx.tenantId, input.serviceId],
    );
    const item = it.rows[0];
    if (!item || item.archived_at || item.kind !== CatalogueItemKind.SERVICE) throw notFound("Service");
    if (!item.available) throw new AppError(ErrorCode.CONFLICT, "This service is not available for booking.", { serviceId: input.serviceId });
    let duration = item.duration_minutes;
    if (input.variantId) {
      const v = await sql.query<{ duration_minutes: number | null; active: boolean }>(
        "select duration_minutes, active from catalogue_variants where tenant_id = $1 and id = $2 and item_id = $3",
        [ctx.tenantId, input.variantId, input.serviceId],
      );
      const variant = v.rows[0];
      if (!variant || !variant.active) throw notFound("Variant");
      duration = variant.duration_minutes ?? duration;
    }
    if (duration === null) throw new AppError(ErrorCode.VALIDATION_FAILED, "This service has no duration.", { serviceId: input.serviceId });
    service = { id: input.serviceId, name: item.name, variantId: input.variantId ?? null, durationMinutes: duration, bufferMinutes: item.buffer_minutes };
  } else {
    service = { id: null, name: null, variantId: null, durationMinutes: input.durationMinutes as number, bufferMinutes: input.bufferMinutes ?? 0 };
  }

  // window (UTC)
  const windowStart = localToUtcMs(from, 0, tz);
  const windowEnd = localToUtcMs(addDays(to, 1), 0, tz);
  const window: TimeRange = { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() };

  // candidate resources
  const params: unknown[] = [ctx.tenantId, input.locationId];
  const add = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  let fromSql = "resources r";
  const where = ["r.tenant_id = $1", "r.archived_at is null", "r.active", "(r.location_id is null or r.location_id = $2)"];
  if (input.serviceId) {
    fromSql = `resources r join catalogue_items i on i.tenant_id = r.tenant_id and i.id = ${add(input.serviceId)}::uuid`;
    where.push(ELIGIBLE_SQL);
  }
  if (input.resourceType) where.push(`r.type = ${add(input.resourceType)}`);
  if (input.resourceIds) where.push(`r.id = any(${add(input.resourceIds)}::uuid[])`);
  if (input.partySize !== undefined) {
    const p = add(input.partySize);
    where.push(`r.capacity_units >= ${p}::int and (r.allocation_mode = 'shared' or r.min_units <= ${p}::int)`);
  }
  const rres = await sql.query<{ id: string; name: string; type: string; allocation_mode: "exclusive" | "shared"; capacity_units: number; min_units: number }>(
    `select r.id, r.name, r.type, r.allocation_mode, r.capacity_units, r.min_units
       from ${fromSql} where ${where.join(" and ")} order by lower(r.name), r.id limit ${MAX_RESOURCES}`,
    params,
  );
  const ids = rres.rows.map((r) => r.id);

  const locWeek = await readLocationHours(sql, ctx, input.locationId);

  // holidays in range: location-specific beats all-location for the same date
  const hres = await sql.query<HolidayRow>(
    `select location_id, holiday_date::text as d, closed, open_time::text as o, close_time::text as c from holidays
      where tenant_id = $1 and (location_id is null or location_id = $2) and holiday_date between $3::date and $4::date`,
    [ctx.tenantId, input.locationId, from, to],
  );
  const dayRule = new Map<string, { closed: boolean; intervals: TimeInterval[]; specific: boolean }>();
  for (const h of hres.rows) {
    const specific = h.location_id !== null;
    const existing = dayRule.get(h.d);
    if (existing && existing.specific && !specific) continue;
    dayRule.set(h.d, {
      closed: h.closed,
      intervals: h.closed || h.o === null || h.c === null ? [] : [{ start: hm(h.o), end: hm(h.c) }],
      specific,
    });
  }

  // schedules, breaks, time off and allocations for all candidates at once
  const schedules = new Map<string, ScheduleRow[]>();
  const allocations = new Map<string, AllocationRange[]>();
  const breaksByResource = await loadWeeklyBreaks(sql, ctx, ids);
  const timeOffByResource = new Map<string, TimeRange[]>();
  if (ids.length > 0) {
    // half-open overlap with the window: starts_at < windowEnd and ends_at > windowStart
    const tres = await sql.query<{ resource_id: string; s: Date; e: Date }>(
      `select resource_id, starts_at as s, ends_at as e from resource_time_off
        where tenant_id = $1 and resource_id = any($2::uuid[]) and starts_at < $4 and ends_at > $3
        order by starts_at, id`,
      [ctx.tenantId, ids, new Date(windowStart), new Date(windowEnd)],
    );
    for (const t of tres.rows) {
      const list = timeOffByResource.get(t.resource_id) ?? [];
      list.push({ start: t.s.toISOString(), end: t.e.toISOString() });
      timeOffByResource.set(t.resource_id, list);
    }

    const sres = await sql.query<ScheduleRow>(
      `select resource_id, weekday, start_time::text as s, end_time::text as e, valid_from::text as vf, valid_to::text as vt
         from resource_schedules where tenant_id = $1 and resource_id = any($2::uuid[]) order by weekday, start_time`,
      [ctx.tenantId, ids],
    );
    for (const r of sres.rows) {
      const list = schedules.get(r.resource_id) ?? [];
      list.push(r);
      schedules.set(r.resource_id, list);
    }

    const pad = service.bufferMinutes * 60_000;
    const ares = await sql.query<AllocationRow>(
      `select resource_id, lower(period) as s, upper(period) as e, units from booking_allocations
        where tenant_id = $1 and resource_id = any($2::uuid[]) and active and (expires_at is null or expires_at > $3)
          and period && tstzrange($4, $5, '[)') and ($6::uuid is null or booking_id <> $6::uuid)
        order by lower(period)`,
      [ctx.tenantId, ids, ctx.now(), new Date(windowStart - pad), new Date(windowEnd + pad), input.excludeBookingId ?? null],
    );
    for (const a of ares.rows) {
      const list = allocations.get(a.resource_id) ?? [];
      list.push({ start: a.s.toISOString(), end: a.e.toISOString(), units: a.units });
      allocations.set(a.resource_id, list);
    }
  }

  const dates = eachLocalDate(from, to);
  const resources: ResourceAvailabilityInput[] = rres.rows.map((r) => {
    const rows = schedules.get(r.id) ?? [];
    const hasSchedule = rows.length > 0;
    const openEnded = rows.filter((x) => x.vf === null && x.vt === null);

    // base weekly pattern
    const resWeek = weekFromRows(openEnded);
    const hours = emptyWeek();
    for (const d of WEEKDAYS) hours[d] = hasSchedule ? intersectIntervals(locWeek[d], resWeek[d]) : locWeek[d].map((iv) => ({ ...iv }));

    const holidays: string[] = [];
    const dateOverrides: Record<string, TimeInterval[]> = {};
    for (const date of dates) {
      const wd: Weekday = weekdayOf(date);
      const rule = dayRule.get(date);
      if (rule?.closed) {
        holidays.push(date);
        continue;
      }
      const locIntervals = rule ? rule.intervals : locWeek[wd];
      let effective: TimeInterval[];
      if (!hasSchedule) {
        effective = locIntervals;
      } else {
        const wdIdx = WEEKDAYS.indexOf(wd);
        const valid = rows.filter((x) => x.weekday === wdIdx && (x.vf === null || x.vf <= date) && (x.vt === null || x.vt >= date));
        effective = intersectIntervals(locIntervals, weekFromRows(valid)[wd]);
      }
      if (!sameIntervals(effective, hours[wd])) dateOverrides[date] = effective;
    }

    const ownBreaks = breaksByResource.get(r.id);

    return {
      resourceId: r.id,
      name: r.name,
      type: r.type,
      allocationMode: r.allocation_mode,
      capacityUnits: r.capacity_units,
      minUnits: r.min_units,
      hours,
      dateOverrides,
      breaks: ownBreaks ?? emptyWeek(),
      hasOwnBreaks: ownBreaks !== undefined,
      holidays,
      timeOff: timeOffByResource.get(r.id) ?? [],
      allocations: allocations.get(r.id) ?? [],
    };
  });

  return { timezone: tz, locationId: input.locationId, from, to, window, service, resources };
});

// ---- pure helpers for the booking engine -------------------------------------------------------------

export interface SlotOptions {
  /** Drop slots starting before this instant (lead time, "now"). */
  notBefore?: string;
  /** Distance between slot starts. Default 15 (shared DEFAULT_STEP_MINUTES). */
  stepMinutes?: number;
  /** Units needed from a shared resource. Default 1. */
  units?: number;
}

/**
 * The `SlotRequest` for one resource on one local date. Hours for that weekday are replaced by the date's override
 * when there is one. For shared resources `allocations` is empty here (they do not block each other); capacity is
 * checked by `generateResourceSlots`.
 */
export function slotRequestFor(inputs: AvailabilityInputs, resource: ResourceAvailabilityInput, date: string, options: SlotOptions = {}): SlotRequest {
  const wd = weekdayOf(date);
  const override = resource.dateOverrides[date];
  const hours: WeeklyHours = override ? { ...resource.hours, [wd]: override } : resource.hours;
  const req: SlotRequest = {
    timezone: inputs.timezone,
    date,
    hours,
    breaks: resource.breaks[wd],
    holidays: resource.holidays,
    allocations: resource.allocationMode === "exclusive" ? resource.allocations : [],
    durationMinutes: inputs.service.durationMinutes,
    bufferMinutes: inputs.service.bufferMinutes,
  };
  if (options.stepMinutes !== undefined) req.stepMinutes = options.stepMinutes;
  if (options.notBefore !== undefined) req.notBefore = options.notBefore;
  return req;
}

/** Highest number of units in use at any instant of [start, end) by the given allocations. */
export function peakUnits(allocations: readonly AllocationRange[], start: string, end: string): number {
  const s = Date.parse(start);
  const e = Date.parse(end);
  const overlapping = allocations.filter((a) => Date.parse(a.start) < e && s < Date.parse(a.end));
  const points = [s, ...overlapping.map((a) => Date.parse(a.start)).filter((t) => t > s && t < e)];
  let peak = 0;
  for (const t of points) {
    let used = 0;
    for (const a of overlapping) if (Date.parse(a.start) <= t && t < Date.parse(a.end)) used += a.units;
    if (used > peak) peak = used;
  }
  return peak;
}

/**
 * Slots for one resource on one local date: `generateSlots`, then minus time off, and for shared resources minus slots
 * where `units` more would exceed capacity. This is the decision logic over the loader's data; the database still has
 * the last word when the booking is written.
 */
export function generateResourceSlots(inputs: AvailabilityInputs, resource: ResourceAvailabilityInput, date: string, options: SlotOptions = {}): TimeRange[] {
  let slots = generateSlots(slotRequestFor(inputs, resource, date, options));
  if (resource.timeOff.length > 0) slots = slots.filter((s) => !overlapsAny(s.start, s.end, resource.timeOff));
  if (resource.allocationMode === "shared") {
    const units = options.units ?? 1;
    if (units > resource.capacityUnits) return [];
    slots = slots.filter((s) => peakUnits(resource.allocations, s.start, s.end) + units <= resource.capacityUnits);
  }
  return slots;
}

export interface ResourceSlot extends TimeRange {
  resourceId: string;
  resourceName: string;
}

/** Slots for every candidate resource over the whole requested range, ordered by start time then resource name. */
export function generateAllSlots(inputs: AvailabilityInputs, options: SlotOptions = {}): ResourceSlot[] {
  const out: ResourceSlot[] = [];
  const dates = eachLocalDate(inputs.from, inputs.to);
  for (const resource of inputs.resources) {
    for (const date of dates) {
      for (const s of generateResourceSlots(inputs, resource, date, options)) {
        out.push({ ...s, resourceId: resource.resourceId, resourceName: resource.name });
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.resourceName.localeCompare(b.resourceName) || a.resourceId.localeCompare(b.resourceId));
}
