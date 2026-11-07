// Hold expiry for one tenant. The cross-tenant sweep for the background job is expireBookingHolds() in @qenbel/db;
// this is the same database function under the tenant's own Row-Level Security, plus an audit row per expired hold.
import { z } from "zod";
import type { EngineContext, SqlClient } from "@qenbel/shared";
import { BookingAuditAction, recordAudit } from "./events.ts";
import { parseOrThrow } from "./schemas.ts";
import { assertScope, guarded } from "./util.ts";

const expireInputSchema = z.object({}).strict();

export interface ExpireHoldsResult {
  expired: number;
  bookingIds: string[];
}

/**
 * Mark every hold whose expiry is at or before ctx.now() as EXPIRED and free its slot (database function
 * `expire_booking_holds_for_current_tenant`). Safe to run repeatedly and concurrently: a second run finds nothing
 * (or waits on the first run's row locks and then finds nothing). A late `confirmBooking` after this gets HOLD_EXPIRED.
 * Expiry has no webhook event type, so it writes audit rows only.
 */
export async function expireHolds(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown = {},
): Promise<ExpireHoldsResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    parseOrThrow(expireInputSchema, rawInput);
    const now = ctx.now().toISOString();
    const due = await sql.query<{ id: string; version: number }>(
      `select id, version from bookings
        where tenant_id = $1 and status = 'HOLD' and hold_expires_at is not null and hold_expires_at <= $2::timestamptz
        order by id for update`,
      [ctx.tenantId, now],
    );
    await sql.query("select expire_booking_holds_for_current_tenant($1::timestamptz) as n", [now]);
    for (const b of due.rows) {
      await recordAudit(sql, ctx, BookingAuditAction.EXPIRE, b.id, { fromStatus: "HOLD", toStatus: "EXPIRED", version: Number(b.version) + 1 });
    }
    return { expired: due.rows.length, bookingIds: due.rows.map((b) => b.id) };
  });
}
