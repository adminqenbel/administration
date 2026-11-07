// Business profile, locations (with time zone), weekly business hours (breaks are the gaps between a day's
// intervals) and holidays.
import { z } from "zod";
import {
  AppError, CustomerField, ErrorCode, WEEKDAYS, hmToMinutes, localDateSchema, localTimeSchema, timezoneSchema, weeklyHoursSchema,
  type TimeInterval, type Weekday, type WeeklyHours,
} from "@qenbel/shared";
import {
  SetBuilder, assertRef, count, cursorSchema, decodeCursor, hm, idArg, isoReq, limitSchema, notFound, op, op0, text, toPage,
  type EngineContext, type SqlClient,
} from "./common.ts";
import { emailInput, phoneInput } from "./customers.ts";

// ---- weekly hours helpers ----------------------------------------------------------------------------

export function emptyWeek(): WeeklyHours {
  return { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };
}

interface HourRow {
  weekday: number;
  s: string;
  e: string;
}

/** Rows (weekday 0 = Sunday) to the shared WeeklyHours shape, intervals sorted by start. */
export function weekFromRows(rows: readonly HourRow[]): WeeklyHours {
  const week = emptyWeek();
  for (const r of rows) {
    const day = WEEKDAYS[r.weekday] as Weekday;
    week[day].push({ start: hm(r.s), end: hm(r.e) });
  }
  for (const d of WEEKDAYS) week[d].sort((a, b) => hmToMinutes(a.start) - hmToMinutes(b.start));
  return week;
}

/** Gaps between consecutive intervals of the same day: these are the breaks. */
export function breaksOf(week: WeeklyHours): Record<Weekday, TimeInterval[]> {
  const out = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] } as Record<Weekday, TimeInterval[]>;
  for (const d of WEEKDAYS) {
    const list = week[d];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1] as TimeInterval;
      const next = list[i] as TimeInterval;
      if (hmToMinutes(next.start) > hmToMinutes(prev.end)) out[d].push({ start: prev.end, end: next.start });
    }
  }
  return out;
}

// ---- locations ---------------------------------------------------------------------------------------

const addressInput = z
  .object({
    line1: text(1, 200).optional(),
    line2: text(1, 200).optional(),
    city: text(1, 100).optional(),
    state: text(1, 100).optional(),
    postalCode: text(1, 20).optional(),
    country: text(1, 100).optional(),
  })
  .strict();

export interface LocationDto {
  id: string;
  name: string;
  address: Record<string, string>;
  phone: string | null;
  email: string | null;
  timezone: string;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LocationRow {
  id: string;
  name: string;
  address: Record<string, unknown> | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  is_default: boolean;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const LOCATION_COLS = "id, name, address, phone, email, timezone, is_default, active, created_at, updated_at";

function cleanAddress(raw: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["line1", "line2", "city", "state", "postalCode", "country"]) {
    const v = raw?.[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  return out;
}

const toLocation = (r: LocationRow): LocationDto => ({
  id: r.id, name: r.name, address: cleanAddress(r.address), phone: r.phone, email: r.email, timezone: r.timezone,
  isDefault: r.is_default, active: r.active, createdAt: isoReq(r.created_at), updatedAt: isoReq(r.updated_at),
});

async function loadLocation(sql: SqlClient, ctx: EngineContext, id: string): Promise<LocationDto> {
  const res = await sql.query<LocationRow>(`select ${LOCATION_COLS} from locations where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Location");
  return toLocation(row);
}

async function tenantTimezone(sql: SqlClient, ctx: EngineContext): Promise<string> {
  const res = await sql.query<{ default_timezone: string }>("select default_timezone from tenants where id = $1", [ctx.tenantId]);
  return res.rows[0]?.default_timezone ?? "Asia/Kolkata";
}

export const createLocation = op(
  z
    .object({
      name: text(1, 200),
      address: addressInput.optional(),
      phone: phoneInput.optional(),
      email: emailInput.optional(),
      timezone: timezoneSchema.optional(),
      isDefault: z.boolean().optional(),
    })
    .strict(),
  async (sql, ctx, input): Promise<LocationDto> => {
    // Serialise default-location changes within the tenant.
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ctx.tenantId}:locations`]);
    const hasDefault = (await sql.query("select 1 from locations where tenant_id = $1 and is_default", [ctx.tenantId])).rows.length > 0;
    const makeDefault = input.isDefault === true || !hasDefault;
    if (makeDefault) await sql.query("update locations set is_default = false where tenant_id = $1 and is_default", [ctx.tenantId]);
    const res = await sql.query<{ id: string }>(
      `insert into locations (tenant_id, name, address, phone, email, timezone, is_default)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7) returning id`,
      [ctx.tenantId, input.name, JSON.stringify(input.address ?? {}), input.phone ?? null, input.email ?? null, input.timezone ?? (await tenantTimezone(sql, ctx)), makeDefault],
    );
    return loadLocation(sql, ctx, (res.rows[0] as { id: string }).id);
  },
);

export const updateLocation = op(
  z
    .object({
      locationId: idArg,
      name: text(1, 200).optional(),
      address: addressInput.optional(),
      phone: phoneInput.nullable().optional(),
      email: emailInput.nullable().optional(),
      timezone: timezoneSchema.optional(),
      isDefault: z.literal(true).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<LocationDto> => {
    await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`${ctx.tenantId}:locations`]);
    const cur = await sql.query<LocationRow>(`select ${LOCATION_COLS} from locations where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, input.locationId]);
    const row = cur.rows[0];
    if (!row) throw notFound("Location");
    if (input.isDefault && !row.active) throw new AppError(ErrorCode.CONFLICT, "An archived location cannot be the default.");
    if (input.isDefault) await sql.query("update locations set is_default = false where tenant_id = $1 and is_default and id <> $2", [ctx.tenantId, input.locationId]);
    const set = new SetBuilder([ctx.tenantId, input.locationId]);
    if (input.name !== undefined) set.set("name", input.name);
    if (input.address !== undefined) set.set("address", JSON.stringify(input.address), "::jsonb");
    if (input.phone !== undefined) set.set("phone", input.phone);
    if (input.email !== undefined) set.set("email", input.email);
    if (input.timezone !== undefined) set.set("timezone", input.timezone);
    if (input.isDefault) set.set("is_default", true);
    if (!set.empty) await sql.query(`update locations set ${set.clause} where tenant_id = $1 and id = $2`, set.values);
    return loadLocation(sql, ctx, input.locationId);
  },
);

export const getLocation = op(z.object({ locationId: idArg }).strict(), (sql, ctx, input) => loadLocation(sql, ctx, input.locationId));

export const listLocations = op(z.object({ includeArchived: z.boolean().default(false) }).strict(), async (sql, ctx, input): Promise<LocationDto[]> => {
  const res = await sql.query<LocationRow>(
    `select ${LOCATION_COLS} from locations where tenant_id = $1 and ($2::boolean or active) order by is_default desc, lower(name), id limit 200`,
    [ctx.tenantId, input.includeArchived],
  );
  return res.rows.map(toLocation);
});

/** Soft delete (`active = false`). Refused for the default location, and while live bookings are still to come there. */
export const archiveLocation = op(z.object({ locationId: idArg }).strict(), async (sql, ctx, input): Promise<LocationDto> => {
  const cur = await sql.query<LocationRow>(`select ${LOCATION_COLS} from locations where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, input.locationId]);
  const row = cur.rows[0];
  if (!row) throw notFound("Location");
  if (!row.active) return toLocation(row);
  if (row.is_default) throw new AppError(ErrorCode.CONFLICT, "Choose another default location before archiving this one.");
  const upcoming = await sql.query<{ n: string }>(
    `select count(*) as n from bookings where tenant_id = $1 and location_id = $2 and ends_at > $3
        and (status in ('CONFIRMED', 'CHECKED_IN') or (status = 'HOLD' and hold_expires_at > $3))`,
    [ctx.tenantId, input.locationId, ctx.now()],
  );
  const n = count((upcoming.rows[0] as { n: string }).n);
  if (n > 0) {
    throw new AppError(ErrorCode.CONFLICT, `This location has ${n} upcoming booking${n === 1 ? "" : "s"}. Move or cancel them first.`, { upcomingBookings: n });
  }
  await sql.query("update locations set active = false where tenant_id = $1 and id = $2", [ctx.tenantId, input.locationId]);
  return loadLocation(sql, ctx, input.locationId);
});

export const restoreLocation = op(z.object({ locationId: idArg }).strict(), async (sql, ctx, input): Promise<LocationDto> => {
  const res = await sql.query("update locations set active = true where tenant_id = $1 and id = $2 returning id", [ctx.tenantId, input.locationId]);
  if (res.rows.length === 0) throw notFound("Location");
  return loadLocation(sql, ctx, input.locationId);
});

// ---- business hours ----------------------------------------------------------------------------------

export interface LocationHours {
  locationId: string;
  timezone: string;
  hours: WeeklyHours;
  /** Gaps inside a day's opening intervals (for example a lunch break). Derived, read only. */
  breaks: Record<Weekday, TimeInterval[]>;
}

export async function readLocationHours(sql: SqlClient, ctx: EngineContext, locationId: string): Promise<WeeklyHours> {
  const res = await sql.query<HourRow>(
    "select weekday, open_time::text as s, close_time::text as e from business_hours where tenant_id = $1 and location_id = $2 order by weekday, open_time",
    [ctx.tenantId, locationId],
  );
  return weekFromRows(res.rows);
}

export const getLocationHours = op(z.object({ locationId: idArg }).strict(), async (sql, ctx, input): Promise<LocationHours> => {
  const loc = await loadLocation(sql, ctx, input.locationId);
  const hours = await readLocationHours(sql, ctx, input.locationId);
  return { locationId: loc.id, timezone: loc.timezone, hours, breaks: breaksOf(hours) };
});

/**
 * Replace the whole weekly pattern of a location. A day with several intervals has breaks between them
 * (09:00-13:00 and 14:00-18:00 means a break 13:00-14:00). An empty day is closed. "24:00" may end an interval.
 */
export const setLocationHours = op(z.object({ locationId: idArg, hours: weeklyHoursSchema }).strict(), async (sql, ctx, input): Promise<LocationHours> => {
  const loc = await sql.query("select 1 from locations where tenant_id = $1 and id = $2 for update", [ctx.tenantId, input.locationId]);
  if (loc.rows.length === 0) throw notFound("Location");
  await sql.query("delete from business_hours where tenant_id = $1 and location_id = $2", [ctx.tenantId, input.locationId]);
  for (let dow = 0; dow < 7; dow++) {
    for (const iv of input.hours[WEEKDAYS[dow] as Weekday]) {
      await sql.query(
        "insert into business_hours (tenant_id, location_id, weekday, open_time, close_time) values ($1, $2, $3, $4::time, $5::time)",
        [ctx.tenantId, input.locationId, dow, iv.start, iv.end],
      );
    }
  }
  const l = await loadLocation(sql, ctx, input.locationId);
  const hours = await readLocationHours(sql, ctx, input.locationId);
  return { locationId: l.id, timezone: l.timezone, hours, breaks: breaksOf(hours) };
});

// ---- holidays ----------------------------------------------------------------------------------------

export interface HolidayDto {
  id: string;
  locationId: string | null;
  date: string;
  name: string;
  closed: boolean;
  openTime: string | null;
  closeTime: string | null;
}

interface HolidayRow {
  id: string;
  location_id: string | null;
  d: string;
  name: string;
  closed: boolean;
  o: string | null;
  c: string | null;
}

const HOLIDAY_COLS = "id, location_id, holiday_date::text as d, name, closed, open_time::text as o, close_time::text as c";

const toHoliday = (r: HolidayRow): HolidayDto => ({
  id: r.id, locationId: r.location_id, date: r.d, name: r.name, closed: r.closed,
  openTime: r.o === null ? null : hm(r.o), closeTime: r.c === null ? null : hm(r.c),
});

function checkHolidayTimes(closed: boolean, open: string | null, close: string | null): void {
  const bad = (message: string) =>
    new AppError(ErrorCode.VALIDATION_FAILED, message, { issues: [{ path: "closed", message }] });
  if (closed && (open !== null || close !== null)) throw bad("A closed day has no opening times.");
  if (!closed) {
    if (open === null || close === null) throw bad("Special hours need an opening and a closing time.");
    if (hmToMinutes(close) <= hmToMinutes(open)) throw bad("Closing time must be after opening time.");
  }
}

async function loadHoliday(sql: SqlClient, ctx: EngineContext, id: string): Promise<HolidayDto> {
  const res = await sql.query<HolidayRow>(`select ${HOLIDAY_COLS} from holidays where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const row = res.rows[0];
  if (!row) throw notFound("Holiday");
  return toHoliday(row);
}

/** A date a location is closed, or open on special hours. `locationId` omitted or null means every location. */
export const createHoliday = op(
  z
    .object({
      locationId: idArg.nullable().optional(),
      date: localDateSchema,
      name: text(1, 200),
      closed: z.boolean().default(true),
      openTime: localTimeSchema.optional(),
      closeTime: localTimeSchema.optional(),
    })
    .strict(),
  async (sql, ctx, input): Promise<HolidayDto> => {
    checkHolidayTimes(input.closed, input.openTime ?? null, input.closeTime ?? null);
    if (input.locationId) await assertRef(sql, ctx, "locations", input.locationId, "locationId");
    const res = await sql.query<{ id: string }>(
      `insert into holidays (tenant_id, location_id, holiday_date, name, closed, open_time, close_time)
       values ($1, $2, $3::date, $4, $5, $6::time, $7::time) returning id`,
      [ctx.tenantId, input.locationId ?? null, input.date, input.name, input.closed, input.openTime ?? null, input.closeTime ?? null],
    );
    return loadHoliday(sql, ctx, (res.rows[0] as { id: string }).id);
  },
);

export const updateHoliday = op(
  z
    .object({
      holidayId: idArg,
      name: text(1, 200).optional(),
      closed: z.boolean().optional(),
      openTime: localTimeSchema.nullable().optional(),
      closeTime: localTimeSchema.nullable().optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<HolidayDto> => {
    const cur = await sql.query<HolidayRow>(`select ${HOLIDAY_COLS} from holidays where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, input.holidayId]);
    const row = cur.rows[0];
    if (!row) throw notFound("Holiday");
    const closed = input.closed ?? row.closed;
    let open = input.openTime === undefined ? (row.o === null ? null : hm(row.o)) : input.openTime;
    let close = input.closeTime === undefined ? (row.c === null ? null : hm(row.c)) : input.closeTime;
    if (closed) {
      open = null;
      close = null;
    }
    checkHolidayTimes(closed, open, close);
    const set = new SetBuilder([ctx.tenantId, input.holidayId]);
    if (input.name !== undefined) set.set("name", input.name);
    set.set("closed", closed);
    set.set("open_time", open, "::time");
    set.set("close_time", close, "::time");
    await sql.query(`update holidays set ${set.clause} where tenant_id = $1 and id = $2`, set.values);
    return loadHoliday(sql, ctx, input.holidayId);
  },
);

export const deleteHoliday = op(z.object({ holidayId: idArg }).strict(), async (sql, ctx, input): Promise<{ deleted: true }> => {
  const res = await sql.query("delete from holidays where tenant_id = $1 and id = $2 returning id", [ctx.tenantId, input.holidayId]);
  if (res.rows.length === 0) throw notFound("Holiday");
  return { deleted: true };
});

/** With `locationId`: holidays that apply to that location (its own plus the all-location ones). */
export const listHolidays = op(
  z
    .object({ locationId: idArg.optional(), from: localDateSchema.optional(), to: localDateSchema.optional(), limit: limitSchema, cursor: cursorSchema })
    .strict(),
  async (sql, ctx, input) => {
    const cur = decodeCursor(input.cursor, 2);
    const res = await sql.query<HolidayRow>(
      `select ${HOLIDAY_COLS} from holidays
        where tenant_id = $1 and ($2::uuid is null or location_id is null or location_id = $2)
          and ($3::date is null or holiday_date >= $3::date) and ($4::date is null or holiday_date <= $4::date)
          and ($5::date is null or (holiday_date, id) > ($5::date, $6::uuid))
        order by holiday_date, id limit $7`,
      [ctx.tenantId, input.locationId ?? null, input.from ?? null, input.to ?? null, cur?.[0] ?? null, cur?.[1] ?? null, input.limit + 1],
    );
    const page = toPage(res.rows, input.limit, (r) => [r.d, r.id]);
    return { items: page.items.map(toHoliday), nextCursor: page.nextCursor };
  },
);

// ---- business profile --------------------------------------------------------------------------------

const contactSchema = z.object({ phone: phoneInput.optional(), email: emailInput.optional() }).strict();
const cancellationSchema = z
  .object({ summary: text(0, 500), freeCancelHoursBefore: z.number().int().min(0).max(24 * 90).nullable() })
  .strict();
const extraQuestionSchema = z.object({ field: text(1, 60), label: text(1, 200), required: z.boolean() }).strict();
const requiredFieldsSchema = z.array(z.enum(Object.values(CustomerField) as [string, ...string[]])).max(10);

export interface BusinessSettings {
  contact: { phone?: string; email?: string };
  cancellationPolicy: { summary: string; freeCancelHoursBefore: number | null };
  holdMinutes: number;
  requiredCustomerFields: string[];
  extraQuestions: Array<{ field: string; label: string; required: boolean }>;
  currency: string;
}

export const DEFAULT_SETTINGS: BusinessSettings = {
  contact: {},
  cancellationPolicy: { summary: "", freeCancelHoursBefore: null },
  holdMinutes: 10,
  requiredCustomerFields: ["name", "phone"],
  extraQuestions: [],
  currency: "INR",
};

const SETTING_PARSERS: { [K in keyof BusinessSettings]: z.ZodType<BusinessSettings[K]> } = {
  contact: contactSchema as z.ZodType<BusinessSettings["contact"]>,
  cancellationPolicy: cancellationSchema as z.ZodType<BusinessSettings["cancellationPolicy"]>,
  holdMinutes: z.number().int().min(1).max(240),
  requiredCustomerFields: requiredFieldsSchema,
  extraQuestions: z.array(extraQuestionSchema).max(20),
  currency: z.string().regex(/^[A-Z]{3}$/),
};

/** Known settings keys only, each validated on its own; anything else in `tenants.settings` is ignored (never exposed). */
export function readSettings(raw: unknown): BusinessSettings {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(SETTING_PARSERS) as Array<keyof BusinessSettings>) {
    const parsed = (SETTING_PARSERS[key] as z.ZodType).safeParse(src[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as unknown as BusinessSettings;
}

export interface BusinessProfile extends BusinessSettings {
  name: string;
  packId: string | null;
  packVersion: string | null;
  defaultTimezone: string;
  locations: Array<LocationDto & { hours: WeeklyHours; breaks: Record<Weekday, TimeInterval[]> }>;
}

interface TenantRow {
  name: string;
  pack_id: string | null;
  pack_version: string | null;
  default_timezone: string;
  settings: unknown;
}

async function loadTenant(sql: SqlClient, ctx: EngineContext): Promise<TenantRow> {
  const res = await sql.query<TenantRow>("select name, pack_id, pack_version, default_timezone, settings from tenants where id = $1", [ctx.tenantId]);
  const row = res.rows[0];
  if (!row) throw notFound("Business");
  return row;
}

async function locationsWithHours(sql: SqlClient, ctx: EngineContext, includeArchived: boolean) {
  const locs = await listLocations(sql, ctx, { includeArchived });
  const hours = await sql.query<HourRow & { location_id: string }>(
    "select location_id, weekday, open_time::text as s, close_time::text as e from business_hours where tenant_id = $1 order by weekday, open_time",
    [ctx.tenantId],
  );
  const byLoc = new Map<string, HourRow[]>();
  for (const r of hours.rows) {
    const list = byLoc.get(r.location_id) ?? [];
    list.push(r);
    byLoc.set(r.location_id, list);
  }
  return locs.map((l) => {
    const week = weekFromRows(byLoc.get(l.id) ?? []);
    return { ...l, hours: week, breaks: breaksOf(week) };
  });
}

/** Staff view of the business: name, pack, time zone, settings and every location with its hours. */
export const getBusinessProfile = op0(async (sql, ctx): Promise<BusinessProfile> => {
  const t = await loadTenant(sql, ctx);
  return {
    name: t.name,
    packId: t.pack_id,
    packVersion: t.pack_version,
    defaultTimezone: t.default_timezone,
    ...readSettings(t.settings),
    locations: await locationsWithHours(sql, ctx, true),
  };
});

/** Matches the `get_business_profile` tool output, minus bookingMode/orderMode which come from the pack. */
export interface ChannelBusinessProfile {
  businessName: string;
  packId: string | null;
  timezone: string;
  currency: string;
  locations: Array<{
    locationId: string;
    name: string;
    address?: string;
    timezone: string;
    hours: Array<{ dayOfWeek: number; opens: string; closes: string }>;
  }>;
  hours: Array<{ dayOfWeek: number; opens: string; closes: string }>;
  contact: { phone?: string; email?: string };
  cancellationPolicy: { summary: string; freeCancelHoursBefore: number | null };
  holdMinutes: number;
  requiredCustomerFields: string[];
  extraQuestions: Array<{ field: string; label: string; required: boolean }>;
}

/** AI-safe profile: only fields a customer could read on the business's own page. Active locations only. */
export const getBusinessProfileForChannel = op0(async (sql, ctx): Promise<ChannelBusinessProfile> => {
  const t = await loadTenant(sql, ctx);
  const s = readSettings(t.settings);
  const locs = (await locationsWithHours(sql, ctx, false)).filter((l) => l.active);
  const flat = (w: WeeklyHours) =>
    WEEKDAYS.flatMap((d, i) => w[d].map((iv) => ({ dayOfWeek: i, opens: iv.start, closes: iv.end })));
  const primary = locs.find((l) => l.isDefault) ?? locs[0];
  return {
    businessName: t.name,
    packId: t.pack_id,
    timezone: primary?.timezone ?? t.default_timezone,
    currency: s.currency,
    locations: locs.map((l) => {
      const a = l.address;
      const address = [a.line1, a.line2, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(", ").slice(0, 400);
      return {
        locationId: l.id,
        name: l.name,
        ...(address ? { address } : {}),
        timezone: l.timezone,
        hours: flat(l.hours),
      };
    }),
    hours: primary ? flat(primary.hours) : [],
    contact: s.contact,
    cancellationPolicy: s.cancellationPolicy,
    holdMinutes: s.holdMinutes,
    requiredCustomerFields: s.requiredCustomerFields,
    extraQuestions: s.extraQuestions,
  };
});

/** Edit name, default time zone and the known settings. Other keys already in `settings` are preserved. */
export const updateBusinessProfile = op(
  z
    .object({
      name: text(1, 200).optional(),
      defaultTimezone: timezoneSchema.optional(),
      contact: contactSchema.optional(),
      cancellationPolicy: cancellationSchema.optional(),
      holdMinutes: SETTING_PARSERS.holdMinutes.optional(),
      requiredCustomerFields: requiredFieldsSchema.optional(),
      extraQuestions: z.array(extraQuestionSchema).max(20).optional(),
      currency: SETTING_PARSERS.currency.optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0, "Provide at least one field to change"),
  async (sql, ctx, input): Promise<BusinessProfile> => {
    const cur = await sql.query<TenantRow>("select name, pack_id, pack_version, default_timezone, settings from tenants where id = $1 for update", [ctx.tenantId]);
    const row = cur.rows[0];
    if (!row) throw notFound("Business");
    const settings: Record<string, unknown> = { ...((typeof row.settings === "object" && row.settings !== null ? row.settings : {}) as Record<string, unknown>) };
    for (const key of ["contact", "cancellationPolicy", "holdMinutes", "requiredCustomerFields", "extraQuestions", "currency"] as const) {
      if (input[key] !== undefined) settings[key] = input[key];
    }
    await sql.query("update tenants set name = $2, default_timezone = $3, settings = $4::jsonb where id = $1", [
      ctx.tenantId, input.name ?? row.name, input.defaultTimezone ?? row.default_timezone, JSON.stringify(settings),
    ]);
    return getBusinessProfile(sql, ctx);
  },
);
