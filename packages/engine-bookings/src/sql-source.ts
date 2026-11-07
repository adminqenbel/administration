// Private SQL reader for availability inputs, from the real tables:
// locations, business_hours, holidays, resources, resource_schedules, booking_allocations.
//
// The schema has no tables yet for staff time off, daily breaks or "which services a resource can do".
// Until the db agent adds them (see docs/CONTRACT-REQUESTS.md) they are read from resources.attributes:
//   attributes.serviceIds : string[]                       resource can only serve these catalogue items (absent = any)
//   attributes.breaks     : [{ start: "13:00", end: "14:00" }]   daily, local time
//   attributes.timeOff    : [{ start: ISO, end: ISO }]            blocked instants
// Data that cannot be parsed makes the resource unavailable (fail closed), never available.
import { z } from "zod";
import {
  idSchema,
  instantSchema,
  timeIntervalSchema,
  type EngineContext,
  type ResourceType,
  type SqlClient,
  type TimeInterval,
  type TimeRange,
} from "@qenbel/shared";
import type {
  AllocationRow,
  AvailabilityDataSource,
  CandidateQuery,
  HolidayRow,
  HourRow,
  InputsWindow,
  ResourceAvailabilityInputs,
  ResourceCandidate,
  ResourceSummary,
  ScheduleRow,
} from "./availability-source.ts";
import { isoOrThrow, toInt } from "./util.ts";

interface LocationRow {
  id: string;
  timezone: string;
  is_default: boolean;
}

interface ResourceRow {
  id: string;
  name: string;
  type: ResourceType;
  location_id: string | null;
  allocation_mode: "exclusive" | "shared";
  capacity_units: number;
  min_units: number;
  attributes: unknown;
}

const serviceIdsSchema = z.array(idSchema).max(500);
const breaksSchema = z.array(timeIntervalSchema).max(10);
const timeOffSchema = z
  .array(z.object({ start: instantSchema, end: instantSchema }).passthrough())
  .max(2000);

function attrs(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function loadLocations(sql: SqlClient, ctx: EngineContext): Promise<LocationRow[]> {
  const res = await sql.query<LocationRow>(
    "select id, timezone, is_default from locations where tenant_id = $1 and active order by is_default desc, created_at, id",
    [ctx.tenantId],
  );
  return res.rows;
}

function summarise(row: ResourceRow, locations: LocationRow[], fallbackTimezone: string): ResourceSummary {
  const own = row.location_id === null ? undefined : locations.find((l) => l.id === row.location_id);
  const loc = own ?? locations[0];
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    locationId: own?.id ?? loc?.id ?? null,
    timezone: own?.timezone ?? loc?.timezone ?? fallbackTimezone,
    allocationMode: row.allocation_mode,
    capacityUnits: row.capacity_units,
    minUnits: row.min_units,
  };
}

export const sqlAvailabilityDataSource: AvailabilityDataSource = {
  async listResources(sql, ctx, query: CandidateQuery): Promise<ResourceCandidate[]> {
    const params: unknown[] = [ctx.tenantId];
    let where = "tenant_id = $1 and active and archived_at is null";
    if (query.resourceIds !== undefined) {
      params.push([...query.resourceIds]);
      where += ` and id = any($${params.length}::uuid[])`;
    }
    const res = await sql.query<ResourceRow>(
      `select id, name, type, location_id, allocation_mode, capacity_units, min_units, attributes
         from resources where ${where} order by name, id`,
      params,
    );
    const locations = await loadLocations(sql, ctx);
    const explicit = query.resourceIds !== undefined;
    const out: ResourceCandidate[] = [];
    for (const row of res.rows) {
      const summary = summarise(row, locations, query.fallbackTimezone);
      let reason: ResourceCandidate["reason"];
      if (!query.allowedTypes.includes(row.type) || (query.requiredType && row.type !== query.requiredType)) {
        reason = "type";
      } else if (query.catalogueItemId) {
        const ids = serviceIdsSchema.safeParse(attrs(row.attributes).serviceIds);
        const declared = attrs(row.attributes).serviceIds !== undefined;
        if (declared && (!ids.success || !ids.data.includes(query.catalogueItemId))) reason = "service";
      }
      if (reason === undefined && query.partySize) {
        // Tables: the party must fit one table (several tables are booked with resourceIds). Shared: seats left.
        if (row.type === "table" && row.allocation_mode === "exclusive" && explicit === false) {
          if (query.partySize > row.capacity_units || query.partySize < row.min_units) reason = "party_size";
        } else if (row.allocation_mode === "shared" && query.partySize > row.capacity_units) {
          reason = "party_size";
        }
      }
      if (reason !== undefined && !explicit) continue;
      out.push(reason === undefined ? { ...summary, eligible: true } : { ...summary, eligible: false, reason });
    }
    return out;
  },

  async loadInputs(sql, ctx, resources, window: InputsWindow): Promise<ResourceAvailabilityInputs[]> {
    if (resources.length === 0) return [];
    const resourceIds = resources.map((r) => r.id);
    const locationIds = [...new Set(resources.map((r) => r.locationId).filter((x): x is string => x !== null))];

    // Sequential: one client runs one query at a time (pg deprecates overlapping queries on a client).
    const attrRes = await sql.query<{ id: string; attributes: unknown }>(
      "select id, attributes from resources where tenant_id = $1 and id = any($2::uuid[])",
      [ctx.tenantId, resourceIds],
    );
    const hoursRes = await sql.query<{ location_id: string; weekday: number; s: string; e: string }>(
      `select location_id, weekday, to_char(open_time, 'HH24:MI') as s, to_char(close_time, 'HH24:MI') as e
         from business_hours where tenant_id = $1 and location_id = any($2::uuid[]) order by weekday, open_time`,
      [ctx.tenantId, locationIds],
    );
    const schedRes = await sql.query<{ resource_id: string; weekday: number; s: string; e: string; vf: string | null; vt: string | null }>(
      `select resource_id, weekday, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e,
              to_char(valid_from, 'YYYY-MM-DD') as vf, to_char(valid_to, 'YYYY-MM-DD') as vt
         from resource_schedules where tenant_id = $1 and resource_id = any($2::uuid[]) order by weekday, start_time`,
      [ctx.tenantId, resourceIds],
    );
    const holRes = await sql.query<{ location_id: string | null; d: string; closed: boolean; o: string | null; c: string | null }>(
      `select location_id, to_char(holiday_date, 'YYYY-MM-DD') as d, closed,
              to_char(open_time, 'HH24:MI') as o, to_char(close_time, 'HH24:MI') as c
         from holidays
        where tenant_id = $1 and (location_id is null or location_id = any($2::uuid[]))
          and holiday_date between $3::date and $4::date`,
      [ctx.tenantId, locationIds, window.fromDate, window.toDate],
    );
    const allocRes = await sql.query<{ resource_id: string; s: Date; e: Date; units: number }>(
      `select resource_id, lower(period) as s, upper(period) as e, units
         from booking_allocations
        where tenant_id = $1 and resource_id = any($2::uuid[]) and active
          and (expires_at is null or expires_at > $3::timestamptz)
          and period && tstzrange($4::timestamptz, $5::timestamptz, '[)')`,
      [ctx.tenantId, resourceIds, ctx.now().toISOString(), window.from.toISOString(), window.to.toISOString()],
    );

    const attrById = new Map(attrRes.rows.map((r) => [r.id, attrs(r.attributes)]));

    return resources.map((resource): ResourceAvailabilityInputs => {
      const a = attrById.get(resource.id) ?? {};
      let unreadable = false;

      let breaks: TimeInterval[] | null = null;
      if (a.breaks !== undefined) {
        const parsed = breaksSchema.safeParse(a.breaks);
        if (parsed.success) breaks = parsed.data;
        else unreadable = true;
      }
      let timeOff: TimeRange[] = [];
      if (a.timeOff !== undefined) {
        const parsed = timeOffSchema.safeParse(a.timeOff);
        if (parsed.success) {
          timeOff = parsed.data.map((t) => ({ start: new Date(t.start).toISOString(), end: new Date(t.end).toISOString() }));
        } else {
          unreadable = true;
        }
      }

      const businessHours: HourRow[] = hoursRes.rows
        .filter((r) => r.location_id === resource.locationId)
        .map((r) => ({ weekday: toInt(r.weekday), start: r.s, end: r.e }));
      const resourceHours: ScheduleRow[] = schedRes.rows
        .filter((r) => r.resource_id === resource.id)
        .map((r) => ({ weekday: toInt(r.weekday), start: r.s, end: r.e, validFrom: r.vf, validTo: r.vt }));
      // A date-specific row for this location beats an all-locations row.
      const holidayByDate = new Map<string, HolidayRow>();
      for (const h of holRes.rows) {
        if (h.location_id !== null && h.location_id !== resource.locationId) continue;
        const existing = holidayByDate.get(h.d);
        if (existing && h.location_id === null) continue;
        holidayByDate.set(h.d, { date: h.d, closed: h.closed, open: h.o, close: h.c });
      }
      const allocations: AllocationRow[] = allocRes.rows
        .filter((r) => r.resource_id === resource.id)
        .map((r) => ({ start: isoOrThrow(r.s), end: isoOrThrow(r.e), units: toInt(r.units) }));

      return {
        resource,
        businessHours,
        resourceHours,
        holidays: [...holidayByDate.values()],
        breaks,
        timeOff,
        allocations,
        unreadable,
      };
    });
  },
};
