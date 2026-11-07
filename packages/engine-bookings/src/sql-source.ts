// Private SQL reader for availability inputs, from the real tables:
// locations, business_hours, holidays, resources, resource_schedules, booking_allocations.
//
// Staff time off, weekly breaks and "which services a resource can do" come from the tables added in migration 013:
//   resource_time_off(resource_id, starts_at, ends_at)                        blocked interval [starts_at, ends_at)
//   resource_breaks(resource_id, weekday 0=Sunday..6, start_time, end_time)   recurring break, location-local time
//   resource_services(resource_id, catalogue_item_id)                         no rows = any service of the matching type
// The old resources.attributes keys (timeOff, breaks, serviceIds) are neither read nor written any more.
// Break or time-off rows that cannot be understood make the resource unavailable (fail closed), never available.
import { timeIntervalSchema, type EngineContext, type ResourceType, type SqlClient, type TimeRange } from "@qenbel/shared";
import type {
  AllocationRow,
  AvailabilityDataSource,
  BreakRow,
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
      `select id, name, type, location_id, allocation_mode, capacity_units, min_units
         from resources where ${where} order by name, id`,
      params,
    );
    const locations = await loadLocations(sql, ctx);
    // A resource that lists services may serve only those. A resource with no resource_services rows serves any.
    const serves = new Map<string, boolean>();
    if (query.catalogueItemId && res.rows.length > 0) {
      const svc = await sql.query<{ resource_id: string; serves: boolean }>(
        `select resource_id, bool_or(catalogue_item_id = $3::uuid) as serves
           from resource_services where tenant_id = $1 and resource_id = any($2::uuid[]) group by resource_id`,
        [ctx.tenantId, res.rows.map((r) => r.id), query.catalogueItemId],
      );
      for (const r of svc.rows) serves.set(r.resource_id, r.serves === true);
    }
    const explicit = query.resourceIds !== undefined;
    const out: ResourceCandidate[] = [];
    for (const row of res.rows) {
      const summary = summarise(row, locations, query.fallbackTimezone);
      let reason: ResourceCandidate["reason"];
      if (!query.allowedTypes.includes(row.type) || (query.requiredType && row.type !== query.requiredType)) {
        reason = "type";
      } else if (query.catalogueItemId && serves.get(row.id) === false) {
        reason = "service";
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
    const breakRes = await sql.query<{ resource_id: string; weekday: number; s: string; e: string; ragged: boolean }>(
      `select resource_id, weekday, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e,
              (extract(second from start_time) <> 0 or extract(second from end_time) <> 0) as ragged
         from resource_breaks where tenant_id = $1 and resource_id = any($2::uuid[]) order by weekday, start_time`,
      [ctx.tenantId, resourceIds],
    );
    const offRes = await sql.query<{ resource_id: string; s: Date | string; e: Date | string }>(
      `select resource_id, starts_at as s, ends_at as e
         from resource_time_off
        where tenant_id = $1 and resource_id = any($2::uuid[]) and starts_at < $4::timestamptz and ends_at > $3::timestamptz
        order by starts_at`,
      [ctx.tenantId, resourceIds, window.from.toISOString(), window.to.toISOString()],
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

    return resources.map((resource): ResourceAvailabilityInputs => {
      let unreadable = false;

      // No rows: the tenant/pack breaks apply. Any row: the resource's own breaks replace them on every weekday.
      let breaks: BreakRow[] | null = null;
      for (const r of breakRes.rows) {
        if (r.resource_id !== resource.id) continue;
        breaks ??= [];
        const weekday = Number(r.weekday);
        const interval = timeIntervalSchema.safeParse({ start: r.s, end: r.e });
        if (r.ragged || !interval.success || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          unreadable = true;
          continue;
        }
        breaks.push({ weekday, start: interval.data.start, end: interval.data.end });
      }

      const timeOff: TimeRange[] = [];
      for (const r of offRes.rows) {
        if (r.resource_id !== resource.id) continue;
        const start = new Date(r.s).getTime();
        const end = new Date(r.e).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          unreadable = true;
          continue;
        }
        timeOff.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
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
