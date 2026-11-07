// Hold expiry for one tenant. The cross-tenant sweep for the background job is expireBookingHolds() in @qenbel/db;
// it writes no audit or outbox rows, so a job that wants `booking.expired` events should call expireHolds per tenant.
//
// Lock order (same as migration 016 uses in the allocation trigger and both sweeps):
//     resources (ascending id)  ->  bookings (ascending id)  ->  booking_allocations
// Everything here follows it, so expireHolds, createHold and the sweeps cannot deadlock with each other.
import { z } from "zod";
import { BookingStatus, type EngineContext, type SqlClient } from "@qenbel/shared";
import { BookingAuditAction, recordChange } from "./events.ts";
import { loadBooking, toView } from "./repo.ts";
import { parseOrThrow } from "./schemas.ts";
import { assertScope, guarded } from "./util.ts";

const expireInputSchema = z.object({}).strict();

export interface ExpireHoldsResult {
  expired: number;
  bookingIds: string[];
}

/**
 * Expire the due holds, writing an audit row and a `booking.expired` outbox event for each, on the caller's transaction.
 *
 * "Due" = status HOLD and either the booking's `hold_expires_at` or an active allocation's `expires_at` is at or before
 * `cutoff` (null = the database clock, which is what the allocation trigger uses). With `resourceIds` only holds that
 * occupy those resources are considered, and the caller must already hold their resource row locks (`lockResources`);
 * without it the due holds' resources are locked here, ascending.
 *
 * Exactly once per booking: the HOLD -> EXPIRED update only matches a row still in HOLD, and it runs under the booking
 * row lock, so a concurrent expirer finds nothing left to do.
 */
export async function expireDueHolds(
  sql: SqlClient,
  ctx: EngineContext,
  options: { cutoff: Date | null; resourceIds?: readonly string[]; reason: string },
): Promise<string[]> {
  const cutoff = options.cutoff === null ? null : options.cutoff.toISOString();
  const scoped = options.resourceIds !== undefined;
  if (scoped && options.resourceIds?.length === 0) return [];

  if (!scoped) {
    // Resources first: the resources of every due hold, ascending.
    await sql.query(
      `select r.id from resources r
        where r.tenant_id = $1 and r.id in (
          select a.resource_id from booking_allocations a
           where a.tenant_id = $1 and a.active and a.expires_at is not null
             and a.expires_at <= coalesce($2::timestamptz, clock_timestamp())
          union
          select a.resource_id from booking_allocations a
            join bookings b on b.tenant_id = a.tenant_id and b.id = a.booking_id
           where a.tenant_id = $1 and a.active and b.status = 'HOLD' and b.hold_expires_at is not null
             and b.hold_expires_at <= coalesce($2::timestamptz, clock_timestamp()))
        order by r.id for no key update`,
      [ctx.tenantId, cutoff],
    );
  }

  // Then the bookings, ascending.
  const locked = await sql.query<{ id: string }>(
    `select b.id from bookings b
      where b.tenant_id = $1 and b.status = 'HOLD'
        and ((b.hold_expires_at is not null and b.hold_expires_at <= coalesce($2::timestamptz, clock_timestamp())
              and ($3::uuid[] is null or exists (select 1 from booking_allocations a
                                                  where a.tenant_id = b.tenant_id and a.booking_id = b.id and a.active
                                                    and a.resource_id = any($3::uuid[]))))
          or b.id in (select a.booking_id from booking_allocations a
                       where a.tenant_id = $1 and a.active and a.expires_at is not null
                         and a.expires_at <= coalesce($2::timestamptz, clock_timestamp())
                         and ($3::uuid[] is null or a.resource_id = any($3::uuid[]))))
      order by b.id for no key update`,
    [ctx.tenantId, cutoff, scoped ? [...(options.resourceIds as readonly string[])] : null],
  );
  if (locked.rows.length === 0) return [];

  // The status change makes bookings_sync_allocations release the allocations (bookings -> allocations).
  const done = await sql.query<{ id: string }>(
    `update bookings set status = 'EXPIRED', version = version + 1, updated_at = now()
      where tenant_id = $1 and id = any($2::uuid[]) and status = 'HOLD'
      returning id`,
    [ctx.tenantId, locked.rows.map((r) => r.id)],
  );
  const ids = done.rows.map((r) => r.id).sort();
  for (const id of ids) {
    const view = toView(await loadBooking(sql, ctx, id));
    await recordChange(sql, ctx, BookingAuditAction.EXPIRE, view, BookingStatus.HOLD, { reason: options.reason });
  }
  return ids;
}

/**
 * Mark every hold whose expiry is at or before ctx.now() as EXPIRED and free its slot. Each expired hold gets an
 * audit row (`booking.expire`) and one `booking.expired` outbox event in the same transaction. Safe to run repeatedly
 * and concurrently: a second run waits on the first run's row locks and then finds nothing. A late `confirmBooking`
 * after this gets HOLD_EXPIRED. Holds that a new booking expired on its own (createHold / rescheduleBooking over an
 * unswept expired hold, judged by the database clock) are expired and announced by that call instead.
 */
export async function expireHolds(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown = {},
): Promise<ExpireHoldsResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    parseOrThrow(expireInputSchema, rawInput);
    const now = ctx.now();
    const bookingIds = await expireDueHolds(sql, ctx, { cutoff: now, reason: "hold_expired" });
    // The database function also releases stray expired allocations (defensive); its locks are already held.
    await sql.query("select expire_booking_holds_for_current_tenant($1::timestamptz) as n", [now.toISOString()]);
    return { expired: bookingIds.length, bookingIds };
  });
}
