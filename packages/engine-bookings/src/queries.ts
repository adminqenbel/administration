// Reads: one booking, a filtered page of bookings, and a booking's history from the audit log.
import { AppError, ErrorCode, addDays, localToUtcMs, type EngineContext, type SqlClient } from "@qenbel/shared";
import { isCustomerChannel, loadBookingFor, subjectOf } from "./access.ts";
import { BOOKING_SELECT, notFound, toView, type BookingRow } from "./repo.ts";
import { getBookingInputSchema, listBookingsInputSchema, parseOrThrow, type ListBookingsInput } from "./schemas.ts";
import type { BookingPage, BookingTimelineEntry, BookingView } from "./types.ts";
import { assertScope, canonicalJson, guarded, isoOrThrow, sha256Hex } from "./util.ts";

/**
 * `{ bookingId }`. An id from another tenant is NOT_FOUND, the same as an id that does not exist. On customer channels
 * so is a booking that is not the subject's own.
 */
export async function getBooking(sql: SqlClient, ctx: EngineContext, rawInput: unknown): Promise<BookingView> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const { bookingId } = parseOrThrow(getBookingInputSchema, rawInput);
    return toView(await loadBookingFor(sql, ctx, bookingId));
  });
}

const CUSTOMER_PAGE_LIMIT = 25;

interface CursorPayload {
  t: string;
  i: string;
  f: string;
}

function filterFingerprint(ctx: EngineContext, input: ListBookingsInput): string {
  const { limit: _limit, cursor: _cursor, ...filters } = input;
  return sha256Hex(canonicalJson({ tenant: ctx.tenantId, filters })).slice(0, 16);
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string, fingerprint: string): CursorPayload {
  const bad = () => new AppError(ErrorCode.VALIDATION_FAILED, "The cursor is not valid for this query.", { field: "cursor" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (parsed === null || typeof parsed !== "object") throw bad();
  const c = parsed as Partial<CursorPayload>;
  if (typeof c.t !== "string" || typeof c.i !== "string" || c.f !== fingerprint || Number.isNaN(Date.parse(c.t))) throw bad();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.i)) throw bad();
  return { t: c.t, i: c.i, f: c.f };
}

/**
 * Bookings, earliest start first (id breaks ties, so paging never skips or repeats). Filters: status, from/to
 * (start time in [from, to)), date (one local day in the default location's zone), resourceId (any allocation of the
 * booking, including released ones), customerId, channel. Cursor is opaque and tied to these filters and this tenant.
 */
export async function listBookings(sql: SqlClient, ctx: EngineContext, rawInput: unknown = {}): Promise<BookingPage> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const input = parseOrThrow(listBookingsInputSchema, rawInput);
    // Customer channels see only the subject's own bookings (verified customer, or this conversation), at most 25 a page.
    const customerChannel = isCustomerChannel(ctx);
    const subject = subjectOf(ctx);
    if (customerChannel) {
      const foreign = input.customerId !== undefined && input.customerId.toLowerCase() !== subject.customerId;
      if ((subject.customerId === null && subject.conversationId === null) || foreign) return { items: [], nextCursor: null };
      input.limit = Math.min(input.limit, CUSTOMER_PAGE_LIMIT);
    }
    const fingerprint = filterFingerprint(ctx, input);

    let from = input.from;
    let to = input.to;
    if (input.date !== undefined) {
      const tzRes = await sql.query<{ tz: string }>(
        `select coalesce(
                  (select timezone from locations where tenant_id = $1 and active order by is_default desc, created_at, id limit 1),
                  (select default_timezone from tenants where id = $1)) as tz`,
        [ctx.tenantId],
      );
      const tz = (tzRes.rows[0] as { tz: string }).tz;
      from = new Date(localToUtcMs(input.date, 0, tz)).toISOString();
      to = new Date(localToUtcMs(addDays(input.date, 1), 0, tz)).toISOString();
    }

    const params: unknown[] = [ctx.tenantId];
    const where: string[] = ["b.tenant_id = $1"];
    const add = (sqlText: string, value: unknown) => {
      params.push(value);
      where.push(sqlText.replace("?", `$${params.length}`));
    };
    if (customerChannel) {
      params.push(subject.customerId, subject.conversationId);
      const c = `$${params.length - 1}::uuid`;
      const v = `$${params.length}::uuid`;
      where.push(`(b.customer_id = ${c} or (b.conversation_id = ${v} and (b.customer_id is null or ${c} is null)))`);
    }
    if (input.status !== undefined) add("b.status = ?", input.status);
    if (from !== undefined) add("b.starts_at >= ?::timestamptz", from);
    if (to !== undefined) add("b.starts_at < ?::timestamptz", to);
    if (input.customerId !== undefined) add("b.customer_id = ?", input.customerId);
    if (input.channel !== undefined) add("b.source_channel = ?", input.channel);
    if (input.resourceId !== undefined) {
      add(
        "exists (select 1 from booking_allocations a where a.tenant_id = b.tenant_id and a.booking_id = b.id and a.resource_id = ?)",
        input.resourceId,
      );
    }
    if (input.cursor !== undefined) {
      const c = decodeCursor(input.cursor, fingerprint);
      params.push(c.t, c.i);
      where.push(`(b.starts_at, b.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(input.limit + 1);
    const res = await sql.query<BookingRow>(
      `select ${BOOKING_SELECT} from bookings b where ${where.join(" and ")} order by b.starts_at, b.id limit $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, input.limit);
    const hasMore = res.rows.length > input.limit;
    const last = rows[rows.length - 1];
    return {
      items: rows.map(toView),
      nextCursor: hasMore && last ? encodeCursor({ t: isoOrThrow(last.starts_at), i: last.id, f: fingerprint }) : null,
    };
  });
}

/** `{ bookingId }`. The booking's history from the audit log, oldest first: who, from which channel, what changed. */
export async function listBookingEvents(sql: SqlClient, ctx: EngineContext, rawInput: unknown): Promise<BookingTimelineEntry[]> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const { bookingId } = parseOrThrow(getBookingInputSchema, rawInput);
    // The history names staff and credentials: staff channels only. A customer channel gets NOT_FOUND, like an unknown id.
    if (isCustomerChannel(ctx)) throw notFound();
    const exists = await sql.query("select 1 from bookings where tenant_id = $1 and id = $2", [ctx.tenantId, bookingId]);
    if (exists.rows.length === 0) throw notFound();
    const res = await sql.query<{
      created_at: Date;
      action: string;
      actor_kind: string;
      actor_id: string | null;
      channel: string | null;
      details: Record<string, unknown>;
    }>(
      `select created_at, action, actor_kind, actor_id, channel, details from audit_log
        where tenant_id = $1 and entity_type = 'booking' and entity_id = $2 order by seq`,
      [ctx.tenantId, bookingId],
    );
    return res.rows.map((r) => ({
      at: isoOrThrow(r.created_at),
      action: r.action,
      actorKind: r.actor_kind,
      actorId: r.actor_id,
      channel: r.channel,
      details: r.details,
    }));
  });
}
