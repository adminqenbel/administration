// Resources (staff, room, table, equipment, doctor, vehicle): CRUD with archive, weekly schedules, time off,
// and which services each resource can serve.
//
// INTERIM STORAGE: migration 005 has no table for time off, daily breaks or resource-to-service links.
// Until the coordinator adds them (see docs/CONTRACT-REQUESTS.md), these three live in the `attributes` jsonb of the
// resource row under reserved keys: `timeOff`, `breaks`, `serviceIds`. All access goes through this file, so moving to
// real tables later is a change here only. Writes lock the resource row (`for update`), so they cannot interleave.
import { z } from "zod";
import {
  AllocationMode, AppError, ErrorCode, ResourceType, WEEKDAYS, hmToMinutes, instantSchema, localDateOf, localToUtcMs, timeIntervalSchema,
  weekdayOf, weeklyHoursSchema, type TimeInterval, type Weekday, type WeeklyHours,
} from "@qenbel/shared";
import {
  SetBuilder, assertRef, count, cursorSchema, decodeCursor, idArg, iso, isoReq, likeEscape, limitSchema, notFound, op, text, toPage,
  type EngineContext, type SqlClient,
} from "./common.ts";
import { weekFromRows } from "./business.ts";

export const RESERVED_RESOURCE_KEYS = ["timeOff", "breaks", "serviceIds"] as const;

const typeInput = z.enum(Object.values(ResourceType) as [string, ...string[]]);
const modeInput = z.enum(Object.values(AllocationMode) as [string, ...string[]]);
const archivedFilter = z.enum(["exclude", "include", "only"]).default("exclude");

const attrsInput = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([text(0, 500), z.number().finite(), z.boolean()]))
  .refine((r) => Object.keys(r).length <= 20, "At most 20 attributes")
  .refine((r) => !Object.keys(r).some((k) => (RESERVED_RESOURCE_KEYS as readonly string[]).includes(k)), "timeOff, breaks and serviceIds are managed by their own functions");

export interface TimeOffDto {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface ResourceDto {
  id: string;
  locationId: string | null;
  userId: string | null;
  type: string;
  name: string;
  allocationMode: string;
  capacityUnits: number;
  minUnits: number;
  attributes: Record<string, unknown>;
  /** Explicit service links. Empty means "any service whose required resource type matches". */
  serviceIds: string[];
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ResourceRow {
  id: string;
  location_id: string | null;
  user_id: string | null;
  type: string;
  name: string;
  allocation_mode: string;
  capacity_units: number;
  min_units: number;
  attributes: Record<string, unknown> | null;
  active: boolean;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  name_key?: string;
}

const RESOURCE_COLS = `r.id, r.location_id, r.user_id, r.type, r.name, r.allocation_mode, r.capacity_units, r.min_units, r.attributes,
  r.active, r.archived_at, r.created_at, r.updated_at, lower(r.name) as name_key`;

// ---- interim extras ----------------------------------------------------------------------------------

export interface ResourceExtras {
  timeOff: Array<{ id: string; startsAt: string; endsAt: string; reason: string | null }>;
  breaks: TimeInterval[];
  serviceIds: string[];
}

const extrasSchema = z.object({
  timeOff: z.array(z.object({ id: z.string(), startsAt: z.string(), endsAt: z.string(), reason: z.string().nullable().optional() })).catch([]),
  breaks: z.array(timeIntervalSchema).catch([]),
  serviceIds: z.array(z.string()).catch([]),
});

export function readExtras(attributes: Record<string, unknown> | null): ResourceExtras {
  const parsed = extrasSchema.parse({
    timeOff: attributes?.timeOff ?? [],
    breaks: attributes?.breaks ?? [],
    serviceIds: attributes?.serviceIds ?? [],
  });
  return {
    timeOff: parsed.timeOff.map((t) => ({ id: t.id, startsAt: t.startsAt, endsAt: t.endsAt, reason: t.reason ?? null })),
    breaks: parsed.breaks,
    serviceIds: parsed.serviceIds,
  };
}

function userAttributes(attributes: Record<string, unknown> | null): Record<string, unknown> {
  const out = { ...(attributes ?? {}) };
  for (const k of RESERVED_RESOURCE_KEYS) delete out[k];
  return out;
}

function toResource(r: ResourceRow): ResourceDto {
  return {
    id: r.id,
    locationId: r.location_id,
    userId: r.user_id,
    type: r.type,
    name: r.name,
    allocationMode: r.allocation_mode,
    capacityUnits: r.capacity_units,
    minUnits: r.min_units,
    attributes: userAttributes(r.attributes),
    serviceIds: readExtras(r.attributes).serviceIds,
    active: r.active,
    archivedAt: iso(r.archived_at),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

async function loadResource(sql: SqlClient, ctx: EngineContext, id: string): Promise<ResourceDto> {
  const res = await sql.query<ResourceRow>(`select ${RESOURCE_COLS} from resources r where r.tenant_id = $1 and r.id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Resource");
  return toResource(row);
}

/** Lock the resource row and return it. */
async function lockResource(sql: SqlClient, ctx: EngineContext, id: string): Promise<ResourceRow> {
  const res = await sql.query<ResourceRow>(`select ${RESOURCE_COLS} from resources r where r.tenant_id = $1 and r.id = $2 for update`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Resource");
  return row;
}

async function writeAttributes(sql: SqlClient, ctx: EngineContext, id: string, attrs: Record<string, unknown>): Promise<void> {
  await sql.query("update resources set attributes = $3::jsonb where tenant_id = $1 and id = $2", [ctx.tenantId, id, JSON.stringify(attrs)]);
}

// ---- CRUD --------------------------------------------------------------------------------------------

const createResourceInput = z
  .object({
    type: typeInput,
    name: text(1, 200),
    locationId: idArg.optional(),
    userId: idArg.optional(),
    allocationMode: modeInput.default("exclusive"),
    capacityUnits: z.number().int().min(1).max(10_000).default(1),
    minUnits: z.number().int().min(1).max(10_000).default(1),
    attributes: attrsInput.optional(),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((v) => v.minUnits <= v.capacityUnits, "minUnits cannot exceed capacityUnits");

export const createResource = op(createResourceInput, async (sql, ctx, input): Promise<ResourceDto> => {
  if (input.locationId) await assertRef(sql, ctx, "locations", input.locationId, "locationId");
  if (input.userId) await assertRef(sql, ctx, "users", input.userId, "userId");
  const res = await sql.query<{ id: string }>(
    `insert into resources (tenant_id, location_id, user_id, type, name, allocation_mode, capacity_units, min_units, attributes, active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10) returning id`,
    [
      ctx.tenantId, input.locationId ?? null, input.userId ?? null, input.type, input.name, input.allocationMode, input.capacityUnits,
      input.minUnits, JSON.stringify(input.attributes ?? {}), input.active,
    ],
  );
  return loadResource(sql, ctx, (res.rows[0] as { id: string }).id);
});

export const getResource = op(z.object({ resourceId: idArg }).strict(), (sql, ctx, input) => loadResource(sql, ctx, input.resourceId));

export const updateResource = op(
  z
    .object({
      resourceId: idArg,
      name: text(1, 200).optional(),
      locationId: idArg.nullable().optional(),
      userId: idArg.nullable().optional(),
      allocationMode: modeInput.optional(),
      capacityUnits: z.number().int().min(1).max(10_000).optional(),
      minUnits: z.number().int().min(1).max(10_000).optional(),
      attributes: attrsInput.optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<ResourceDto> => {
    const row = await lockResource(sql, ctx, input.resourceId);
    if (row.archived_at) throw new AppError(ErrorCode.CONFLICT, "Restore this resource before changing it.");
    const cap = input.capacityUnits ?? row.capacity_units;
    const min = input.minUnits ?? row.min_units;
    if (min > cap) throw new AppError(ErrorCode.VALIDATION_FAILED, "minUnits cannot exceed capacityUnits.");
    if (input.locationId) await assertRef(sql, ctx, "locations", input.locationId, "locationId");
    if (input.userId) await assertRef(sql, ctx, "users", input.userId, "userId");

    const set = new SetBuilder([ctx.tenantId, input.resourceId]);
    if (input.name !== undefined) set.set("name", input.name);
    if (input.locationId !== undefined) set.set("location_id", input.locationId);
    if (input.userId !== undefined) set.set("user_id", input.userId);
    if (input.allocationMode !== undefined) set.set("allocation_mode", input.allocationMode);
    if (input.capacityUnits !== undefined) set.set("capacity_units", input.capacityUnits);
    if (input.minUnits !== undefined) set.set("min_units", input.minUnits);
    if (input.active !== undefined) set.set("active", input.active);
    if (input.attributes !== undefined) {
      // Replace user attributes, keep the reserved interim keys.
      const reserved: Record<string, unknown> = {};
      for (const k of RESERVED_RESOURCE_KEYS) if (row.attributes?.[k] !== undefined) reserved[k] = row.attributes[k];
      set.set("attributes", JSON.stringify({ ...input.attributes, ...reserved }), "::jsonb");
    }
    // The database refuses a mode change or a capacity cut while allocations are active (mapped to CONFLICT).
    await sql.query(`update resources set ${set.clause} where tenant_id = $1 and id = $2`, set.values);
    return loadResource(sql, ctx, input.resourceId);
  },
);

/** Active, unexpired allocations on the resource that end after `from`, counted per booking. */
async function countUpcomingBookings(sql: SqlClient, ctx: EngineContext, resourceId: string, from: Date): Promise<number> {
  const res = await sql.query<{ n: string }>(
    `select count(distinct booking_id) as n from booking_allocations
      where tenant_id = $1 and resource_id = $2 and active and upper(period) > $3 and (expires_at is null or expires_at > $3)`,
    [ctx.tenantId, resourceId, from],
  );
  return count((res.rows[0] as { n: string }).n);
}

/** Soft delete. Refused while the resource has upcoming bookings or live holds (R6.4); the count is in `details`. */
export const archiveResource = op(z.object({ resourceId: idArg }).strict(), async (sql, ctx, input): Promise<ResourceDto> => {
  const row = await lockResource(sql, ctx, input.resourceId);
  if (row.archived_at) return toResource(row);
  const n = await countUpcomingBookings(sql, ctx, input.resourceId, ctx.now());
  if (n > 0) {
    throw new AppError(ErrorCode.CONFLICT, `This resource has ${n} upcoming booking${n === 1 ? "" : "s"}. Move or cancel them first.`, { upcomingBookings: n });
  }
  await sql.query("update resources set archived_at = $3 where tenant_id = $1 and id = $2", [ctx.tenantId, input.resourceId, ctx.now()]);
  return loadResource(sql, ctx, input.resourceId);
});

export const restoreResource = op(z.object({ resourceId: idArg }).strict(), async (sql, ctx, input): Promise<ResourceDto> => {
  const res = await sql.query("update resources set archived_at = null where tenant_id = $1 and id = $2 returning id", [ctx.tenantId, input.resourceId]);
  if (res.rows.length === 0) throw notFound("Resource");
  return loadResource(sql, ctx, input.resourceId);
});

/**
 * SQL predicate: may resource `r` serve catalogue item `i`? An explicit link (resource serviceIds) wins; a resource with
 * no explicit links serves services whose required resource type is unset or equals the resource type.
 */
export const ELIGIBLE_SQL = `(
  coalesce(r.attributes -> 'serviceIds', '[]'::jsonb) @> to_jsonb(i.id::text)
  or (jsonb_array_length(coalesce(r.attributes -> 'serviceIds', '[]'::jsonb)) = 0
      and (i.required_resource_type is null or i.required_resource_type = r.type)))`;

export const listResources = op(
  z
    .object({
      type: typeInput.optional(),
      locationId: idArg.optional(),
      serviceId: idArg.optional(),
      query: text(1, 100).optional(),
      archived: archivedFilter,
      limit: limitSchema,
      cursor: cursorSchema,
    })
    .strict(),
  async (sql, ctx, input) => {
    const cur = decodeCursor(input.cursor, 2);
    const where = ["r.tenant_id = $1"];
    const params: unknown[] = [ctx.tenantId];
    const add = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };
    let from = "resources r";
    if (input.archived === "exclude") where.push("r.archived_at is null");
    if (input.archived === "only") where.push("r.archived_at is not null");
    if (input.type) where.push(`r.type = ${add(input.type)}`);
    if (input.locationId) where.push(`r.location_id = ${add(input.locationId)}`);
    if (input.query) where.push(`lower(r.name) like ${add(`%${likeEscape(input.query.toLowerCase())}%`)} escape '\\'`);
    if (input.serviceId) {
      from = `resources r join catalogue_items i on i.tenant_id = r.tenant_id and i.id = ${add(input.serviceId)}::uuid`;
      where.push(ELIGIBLE_SQL);
    }
    if (cur) where.push(`(lower(r.name), r.id) > (${add(cur[0])}, ${add(cur[1])}::uuid)`);
    const limitP = add(input.limit + 1);
    const res = await sql.query<ResourceRow>(
      `select ${RESOURCE_COLS} from ${from} where ${where.join(" and ")} order by lower(r.name), r.id limit ${limitP}`,
      params,
    );
    const page = toPage(res.rows, input.limit, (r) => [r.name_key as string, r.id]);
    return { items: page.items.map(toResource), nextCursor: page.nextCursor };
  },
);

// ---- weekly schedule ---------------------------------------------------------------------------------

export interface ResourceSchedule {
  resourceId: string;
  /** False when the resource has no rows: it then follows the location's opening hours. */
  hasSchedule: boolean;
  /** Open-ended weekly pattern. */
  hours: WeeklyHours;
}

async function resourceTimezone(sql: SqlClient, ctx: EngineContext, locationId: string | null): Promise<string> {
  if (locationId) {
    const r = await sql.query<{ timezone: string }>("select timezone from locations where tenant_id = $1 and id = $2", [ctx.tenantId, locationId]);
    if (r.rows[0]) return r.rows[0].timezone;
  }
  const t = await sql.query<{ default_timezone: string }>("select default_timezone from tenants where id = $1", [ctx.tenantId]);
  return t.rows[0]?.default_timezone ?? "Asia/Kolkata";
}

export const getResourceSchedule = op(z.object({ resourceId: idArg }).strict(), async (sql, ctx, input): Promise<ResourceSchedule> => {
  await assertRef(sql, ctx, "resources", input.resourceId, "resourceId");
  const res = await sql.query<{ weekday: number; s: string; e: string }>(
    `select weekday, start_time::text as s, end_time::text as e from resource_schedules
      where tenant_id = $1 and resource_id = $2 and valid_from is null and valid_to is null order by weekday, start_time`,
    [ctx.tenantId, input.resourceId],
  );
  return { resourceId: input.resourceId, hasSchedule: res.rows.length > 0, hours: weekFromRows(res.rows) };
});

function isEmptyWeek(w: WeeklyHours): boolean {
  return WEEKDAYS.every((d) => w[d].length === 0);
}

/** Bookings (per booking) that do not sit wholly inside one interval of `week` on their local start date. */
async function countOutsideSchedule(sql: SqlClient, ctx: EngineContext, row: ResourceRow, week: WeeklyHours): Promise<number> {
  const tz = await resourceTimezone(sql, ctx, row.location_id);
  const res = await sql.query<{ booking_id: string; s: Date; e: Date }>(
    `select booking_id, lower(period) as s, upper(period) as e from booking_allocations
      where tenant_id = $1 and resource_id = $2 and active and upper(period) > $3 and (expires_at is null or expires_at > $3)
      order by lower(period) limit 5000`,
    [ctx.tenantId, row.id, ctx.now()],
  );
  const outside = new Set<string>();
  for (const a of res.rows) {
    const s = a.s.getTime();
    const e = a.e.getTime();
    const date = localDateOf(s, tz);
    const fits = week[weekdayOf(date)].some(
      (iv) => s >= localToUtcMs(date, hmToMinutes(iv.start), tz) && e <= localToUtcMs(date, hmToMinutes(iv.end), tz),
    );
    if (!fits) outside.add(a.booking_id);
  }
  return outside.size;
}

/**
 * Replace the resource's open-ended weekly working pattern. An all-empty week removes the schedule, so the
 * resource follows the location's hours again. Refused if upcoming bookings would fall outside the new pattern (R6.5).
 */
export const setResourceSchedule = op(z.object({ resourceId: idArg, hours: weeklyHoursSchema }).strict(), async (sql, ctx, input): Promise<ResourceSchedule> => {
  const row = await lockResource(sql, ctx, input.resourceId);
  if (!isEmptyWeek(input.hours)) {
    const n = await countOutsideSchedule(sql, ctx, row, input.hours);
    if (n > 0) {
      throw new AppError(ErrorCode.CONFLICT, `${n} upcoming booking${n === 1 ? "" : "s"} would fall outside this schedule. Move or cancel them first.`, { affectedBookings: n });
    }
  }
  await sql.query("delete from resource_schedules where tenant_id = $1 and resource_id = $2 and valid_from is null and valid_to is null", [ctx.tenantId, input.resourceId]);
  for (let dow = 0; dow < 7; dow++) {
    for (const iv of input.hours[WEEKDAYS[dow] as Weekday]) {
      await sql.query(
        "insert into resource_schedules (tenant_id, resource_id, weekday, start_time, end_time) values ($1, $2, $3, $4::time, $5::time)",
        [ctx.tenantId, input.resourceId, dow, iv.start, iv.end],
      );
    }
  }
  return getResourceSchedule(sql, ctx, { resourceId: input.resourceId });
});

// ---- daily breaks (interim) --------------------------------------------------------------------------

/** Daily breaks for one resource (for example lunch 13:00-14:00 every working day). Replaces the list. */
export const setResourceBreaks = op(
  z
    .object({
      resourceId: idArg,
      breaks: z
        .array(timeIntervalSchema)
        .max(10)
        .refine((list) => {
          const s = [...list].sort((a, b) => hmToMinutes(a.start) - hmToMinutes(b.start));
          return s.every((b, i) => i === 0 || hmToMinutes(b.start) >= hmToMinutes((s[i - 1] as TimeInterval).end));
        }, "Breaks must not overlap"),
    })
    .strict(),
  async (sql, ctx, input): Promise<{ resourceId: string; breaks: TimeInterval[] }> => {
    const row = await lockResource(sql, ctx, input.resourceId);
    const attrs = { ...(row.attributes ?? {}) };
    if (input.breaks.length === 0) delete attrs.breaks;
    else attrs.breaks = input.breaks;
    await writeAttributes(sql, ctx, input.resourceId, attrs);
    return { resourceId: input.resourceId, breaks: input.breaks };
  },
);

export const getResourceBreaks = op(z.object({ resourceId: idArg }).strict(), async (sql, ctx, input) => {
  const r = await loadRaw(sql, ctx, input.resourceId);
  return { resourceId: input.resourceId, breaks: readExtras(r.attributes).breaks };
});

async function loadRaw(sql: SqlClient, ctx: EngineContext, id: string): Promise<ResourceRow> {
  const res = await sql.query<ResourceRow>(`select ${RESOURCE_COLS} from resources r where r.tenant_id = $1 and r.id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Resource");
  return row;
}

// ---- time off (interim) ------------------------------------------------------------------------------

const MAX_TIME_OFF = 500;

/**
 * Add time off (single or ranged). Refused if live bookings or holds overlap it, with the count (R6.5).
 * Times are instants; for a whole local day use that day's start and the next day's start in the location's zone.
 */
export const addResourceTimeOff = op(
  z
    .object({ resourceId: idArg, startsAt: instantSchema, endsAt: instantSchema, reason: text(1, 200).optional() })
    .strict()
    .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), "endsAt must be after startsAt")
    .refine((v) => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 366 * 86_400_000, "Time off is at most 366 days"),
  async (sql, ctx, input): Promise<TimeOffDto> => {
    const row = await lockResource(sql, ctx, input.resourceId);
    if (row.archived_at) throw new AppError(ErrorCode.CONFLICT, "Restore this resource before changing it.");
    const extras = readExtras(row.attributes);
    if (extras.timeOff.length >= MAX_TIME_OFF) throw new AppError(ErrorCode.CONFLICT, `A resource can have at most ${MAX_TIME_OFF} time off entries. Remove old ones first.`);
    const start = new Date(input.startsAt);
    const end = new Date(input.endsAt);
    const hit = await sql.query<{ n: string }>(
      `select count(distinct booking_id) as n from booking_allocations
        where tenant_id = $1 and resource_id = $2 and active and period && tstzrange($3, $4, '[)') and (expires_at is null or expires_at > $5)`,
      [ctx.tenantId, input.resourceId, start, end, ctx.now()],
    );
    const n = count((hit.rows[0] as { n: string }).n);
    if (n > 0) {
      throw new AppError(ErrorCode.CONFLICT, `${n} booking${n === 1 ? "" : "s"} fall in this time. Move or cancel them first.`, { affectedBookings: n });
    }
    const entry = { id: ctx.newId(), startsAt: start.toISOString(), endsAt: end.toISOString(), reason: input.reason ?? null };
    const timeOff = [...extras.timeOff, entry].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    await writeAttributes(sql, ctx, input.resourceId, { ...(row.attributes ?? {}), timeOff });
    return entry;
  },
);

export const removeResourceTimeOff = op(z.object({ resourceId: idArg, timeOffId: z.string().min(1).max(64) }).strict(), async (sql, ctx, input): Promise<{ deleted: true }> => {
  const row = await lockResource(sql, ctx, input.resourceId);
  const extras = readExtras(row.attributes);
  if (!extras.timeOff.some((t) => t.id === input.timeOffId)) throw notFound("Time off");
  const attrs = { ...(row.attributes ?? {}) };
  const rest = extras.timeOff.filter((t) => t.id !== input.timeOffId);
  if (rest.length === 0) delete attrs.timeOff;
  else attrs.timeOff = rest;
  await writeAttributes(sql, ctx, input.resourceId, attrs);
  return { deleted: true };
});

/** Time off overlapping [from, to) when given, else all entries. Ordered by start. */
export const listResourceTimeOff = op(
  z.object({ resourceId: idArg, from: instantSchema.optional(), to: instantSchema.optional() }).strict(),
  async (sql, ctx, input): Promise<TimeOffDto[]> => {
    const row = await loadRaw(sql, ctx, input.resourceId);
    const from = input.from ? Date.parse(input.from) : -Infinity;
    const to = input.to ? Date.parse(input.to) : Infinity;
    return readExtras(row.attributes)
      .timeOff.filter((t) => Date.parse(t.startsAt) < to && Date.parse(t.endsAt) > from)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  },
);

// ---- resource to service eligibility (interim) -------------------------------------------------------

/**
 * Limit a resource to specific services (a haircut by stylists only). Replaces the list; an empty list removes the
 * limit, and the resource then serves services whose required resource type matches its type.
 */
export const setResourceServices = op(
  z.object({ resourceId: idArg, serviceIds: z.array(idArg).max(200) }).strict(),
  async (sql, ctx, input): Promise<ResourceDto> => {
    const row = await lockResource(sql, ctx, input.resourceId);
    const ids = [...new Set(input.serviceIds.map((s) => s.toLowerCase()))];
    if (ids.length > 0) {
      const found = await sql.query<{ n: string }>(
        "select count(*) as n from catalogue_items where tenant_id = $1 and id = any($2::uuid[]) and kind = 'service' and archived_at is null",
        [ctx.tenantId, ids],
      );
      if (count((found.rows[0] as { n: string }).n) !== ids.length) {
        throw new AppError(ErrorCode.NOT_FOUND, "One or more services were not found.", { field: "serviceIds" });
      }
    }
    const attrs = { ...(row.attributes ?? {}) };
    if (ids.length === 0) delete attrs.serviceIds;
    else attrs.serviceIds = ids;
    await writeAttributes(sql, ctx, input.resourceId, attrs);
    return loadResource(sql, ctx, input.resourceId);
  },
);

/** Active, unarchived resources that can serve a service, optionally at one location (resources without a location match every location). */
export const listResourcesForService = op(
  z.object({ serviceId: idArg, locationId: idArg.optional() }).strict(),
  async (sql, ctx, input): Promise<ResourceDto[]> => {
    await assertRef(sql, ctx, "catalogue_items", input.serviceId, "serviceId");
    const res = await sql.query<ResourceRow>(
      `select ${RESOURCE_COLS} from resources r join catalogue_items i on i.tenant_id = r.tenant_id and i.id = $2
        where r.tenant_id = $1 and r.archived_at is null and r.active and ${ELIGIBLE_SQL}
          and ($3::uuid is null or r.location_id is null or r.location_id = $3)
        order by lower(r.name), r.id limit 500`,
      [ctx.tenantId, input.serviceId, input.locationId ?? null],
    );
    return res.rows.map(toResource);
  },
);
