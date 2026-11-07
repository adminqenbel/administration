// Booking reads, row locking and the shared pieces of writes. Every query filters on tenant_id explicitly
// (Row-Level Security is the second wall, not the only one).
import { toPaise } from "@qenbel/db";
import { AppError, ErrorCode, type BookingStatus, type Channel, type EngineContext, type SqlClient } from "@qenbel/shared";
import type { BookingView } from "./types.ts";
import { isoOf, isoOrThrow, toInt } from "./util.ts";

export interface BookingRow {
  id: string;
  reference: string;
  status: BookingStatus;
  version: number;
  source_channel: Channel;
  starts_at: Date;
  ends_at: Date;
  party_size: number | null;
  notes: string | null;
  hold_expires_at: Date | null;
  confirmed_at: Date | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  policy_snapshot: Record<string, unknown> | null;
  deposit_paise: string;
  deposit_status: BookingView["depositStatus"];
  currency: string;
  location_id: string | null;
  customer_id: string | null;
  conversation_id: string | null;
  catalogue_item_id: string | null;
  created_at: Date;
  updated_at: Date;
  resource_ids: string[];
}

export const BOOKING_SELECT = `
  b.id, b.reference, b.status, b.version, b.source_channel, b.starts_at, b.ends_at, b.party_size, b.notes,
  b.hold_expires_at, b.confirmed_at, b.cancelled_at, b.cancellation_reason, b.policy_snapshot,
  b.deposit_paise, b.deposit_status, b.currency, b.location_id, b.customer_id, b.conversation_id, b.catalogue_item_id,
  b.created_at, b.updated_at,
  coalesce(
    (select array_agg(distinct a.resource_id order by a.resource_id)
       from booking_allocations a where a.tenant_id = b.tenant_id and a.booking_id = b.id and a.active),
    (select array_agg(distinct a.resource_id order by a.resource_id)
       from booking_allocations a where a.tenant_id = b.tenant_id and a.booking_id = b.id),
    '{}'::uuid[]) as resource_ids`;

export function toView(row: BookingRow): BookingView {
  const resourceIds = row.resource_ids ?? [];
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    version: toInt(row.version),
    resourceId: resourceIds[0] ?? null,
    resourceIds,
    customerId: row.customer_id,
    catalogueItemId: row.catalogue_item_id,
    locationId: row.location_id,
    startsAt: isoOrThrow(row.starts_at),
    endsAt: isoOrThrow(row.ends_at),
    partySize: row.party_size,
    notes: row.notes,
    holdExpiresAt: isoOf(row.hold_expires_at),
    confirmedAt: isoOf(row.confirmed_at),
    cancelledAt: isoOf(row.cancelled_at),
    cancellationReason: row.cancellation_reason,
    source: row.source_channel,
    depositPaise: toPaise(row.deposit_paise),
    depositStatus: row.deposit_status,
    currency: row.currency,
    policy: row.policy_snapshot ?? {},
    createdAt: isoOrThrow(row.created_at),
    updatedAt: isoOrThrow(row.updated_at),
  };
}

export function notFound(): AppError {
  return new AppError(ErrorCode.NOT_FOUND, "Booking not found.", { entity: "booking" });
}

/** Load one booking. With `lock`, takes the row lock so concurrent changes queue behind this transaction. */
export async function loadBooking(
  sql: SqlClient,
  ctx: EngineContext,
  id: string,
  options: { lock?: boolean } = {},
): Promise<BookingRow> {
  const res = await sql.query<BookingRow>(
    `select ${BOOKING_SELECT} from bookings b where b.tenant_id = $1 and b.id = $2${options.lock ? " for update of b" : ""}`,
    [ctx.tenantId, id],
  );
  const row = res.rows[0];
  if (!row) throw notFound();
  return row;
}

export function assertVersion(row: BookingRow, expected: number | undefined): void {
  if (expected !== undefined && toInt(row.version) !== expected) {
    throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { expectedVersion: expected, currentVersion: toInt(row.version) });
  }
}

/** Active allocations of a booking, with units and resource, in resource_id order. */
export async function loadActiveAllocations(
  sql: SqlClient,
  ctx: EngineContext,
  bookingId: string,
): Promise<{ id: string; resource_id: string; units: number }[]> {
  const res = await sql.query<{ id: string; resource_id: string; units: number }>(
    `select id, resource_id, units from booking_allocations
      where tenant_id = $1 and booking_id = $2 and active order by resource_id, id`,
    [ctx.tenantId, bookingId],
  );
  return res.rows;
}

/**
 * Lock resource rows in id order. Every code path that touches more than one resource takes locks through here
 * (and inserts allocations in the same order), so two bookings with opposite resource lists cannot deadlock.
 */
export async function lockResources(
  sql: SqlClient,
  ctx: EngineContext,
  resourceIds: readonly string[],
): Promise<void> {
  const sorted = [...new Set(resourceIds)].sort();
  if (sorted.length === 0) return;
  await sql.query(
    "select id from resources where tenant_id = $1 and id = any($2::uuid[]) order by id for no key update",
    [ctx.tenantId, sorted],
  );
}

export async function insertAllocations(
  sql: SqlClient,
  ctx: EngineContext,
  bookingId: string,
  rows: readonly { resourceId: string; units: number; startMs: number; endMs: number }[],
  expiresAt: Date | null,
): Promise<void> {
  // resource_id order, always.
  const ordered = [...rows].sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
  for (const r of ordered) {
    await sql.query(
      `insert into booking_allocations (tenant_id, booking_id, resource_id, period, units, active, expires_at)
       values ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'), $6, true, $7)`,
      [ctx.tenantId, bookingId, r.resourceId, new Date(r.startMs).toISOString(), new Date(r.endMs).toISOString(), r.units, expiresAt?.toISOString() ?? null],
    );
  }
}
