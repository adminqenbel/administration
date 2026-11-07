// confirm_booking: HOLD -> CONFIRMED once the hold is live and the pack's required customer fields are present.
import {
  AppError,
  BookingStatus,
  ErrorCode,
  assertTransition,
  confirmBookingSchema,
  missingCustomerFields,
  type CreateCustomer,
  type CustomerField,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { loadConfig, type BookingConfig, type EngineOptions } from "./config.ts";
import { BookingAuditAction, emitOutbox, recordChange } from "./events.ts";
import { withIdempotency } from "./idempotency.ts";
import { normalisePhone } from "./phone.ts";
import { buildSnapshot } from "./policy.ts";
import { assertVersion, loadActiveAllocations, loadBooking, toView } from "./repo.ts";
import { parseOrThrow, splitBookingId } from "./schemas.ts";
import { depositFor, loadService } from "./service.ts";
import type { WriteResult } from "./types.ts";
import { assertScope, guarded } from "./util.ts";

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  attributes: unknown;
}

function fieldsOf(row: CustomerRow): Partial<Record<CustomerField, unknown>> {
  const a = row.attributes !== null && typeof row.attributes === "object" ? (row.attributes as Record<string, unknown>) : {};
  return { name: row.name, phone: row.phone, email: row.email, dateOfBirth: a.dateOfBirth, address: a.address };
}

function missing(list: CustomerField[]): AppError {
  return new AppError(ErrorCode.REQUIRED_FIELDS_MISSING, undefined, { missing: list });
}

/**
 * Resolve the customer for a confirmation. An existing id must be usable; new details reuse the customer with the same
 * phone number (no duplicate) or create one. Required fields are checked against what the customer will have after this call.
 */
async function resolveCustomer(
  sql: SqlClient,
  ctx: EngineContext,
  cfg: BookingConfig,
  body: { customerId?: string | undefined; customer?: CreateCustomer | undefined },
): Promise<{ id: string; created: boolean }> {
  if (body.customerId !== undefined) {
    const res = await sql.query<CustomerRow>(
      "select id, name, phone, email, attributes from customers where tenant_id = $1 and id = $2 and archived_at is null",
      [ctx.tenantId, body.customerId],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, "Customer not found.", { entity: "customer" });
    const gaps = missingCustomerFields(cfg.requiredCustomerFields, fieldsOf(row));
    if (gaps.length > 0) throw missing(gaps);
    return { id: row.id, created: false };
  }

  const details = body.customer as CreateCustomer;
  const phone = details.phone === undefined ? null : normalisePhone(details.phone);
  if (details.phone !== undefined && phone === null) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "Enter a valid phone number.", { issues: [{ path: "customer.phone", message: "Not a valid phone number" }] });
  }
  let existing: CustomerRow | undefined;
  if (phone !== null) {
    const found = await sql.query<CustomerRow>(
      `select id, name, phone, email, attributes from customers
        where tenant_id = $1 and phone = $2 and archived_at is null order by created_at, id limit 1`,
      [ctx.tenantId, phone],
    );
    existing = found.rows[0];
  }
  const provided: Partial<Record<CustomerField, unknown>> = {
    name: details.name,
    phone,
    email: details.email,
    dateOfBirth: details.dateOfBirth,
    address: details.address,
  };
  const merged: Partial<Record<CustomerField, unknown>> = { ...(existing ? fieldsOf(existing) : {}) };
  for (const [k, v] of Object.entries(provided)) if (v !== undefined && v !== null) merged[k as CustomerField] = v;
  const gaps = missingCustomerFields(cfg.requiredCustomerFields, merged);
  if (gaps.length > 0) throw missing(gaps);

  if (existing) return { id: existing.id, created: false };

  const id = ctx.newId();
  const attributes: Record<string, string> = {};
  if (details.dateOfBirth !== undefined) attributes.dateOfBirth = details.dateOfBirth;
  if (details.address !== undefined) attributes.address = details.address;
  await sql.query(
    `insert into customers (id, tenant_id, name, phone, email, source, attributes)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, ctx.tenantId, details.name, phone, details.email ?? null, ctx.actor.channel, JSON.stringify(attributes)],
  );
  if (details.notes !== undefined && details.notes.length > 0) {
    await sql.query("insert into customer_notes (tenant_id, customer_id, body) values ($1, $2, $3)", [ctx.tenantId, id, details.notes]);
  }
  await emitOutbox(sql, ctx, "customer.created", "customer", id, {
    customerId: id,
    source: ctx.actor.channel,
    actor: { kind: ctx.actor.kind, id: ctx.actor.id, channel: ctx.actor.channel },
  });
  return { id, created: true };
}

/**
 * Confirm a live hold. Input: `{ bookingId, customerId | customer, notes?, expectedVersion? }`.
 *  - EXPIRED, past its expiry time, or its slot already released: HOLD_EXPIRED.
 *  - Any other status than HOLD: INVALID_TRANSITION.
 *  - Required customer fields (pack) missing: REQUIRED_FIELDS_MISSING with `details.missing`.
 * Clears the hold expiry, snapshots the cancellation policy and deposit onto the booking, bumps `version`.
 */
export async function confirmBooking(
  sql: SqlClient,
  ctx: EngineContext,
  rawInput: unknown,
  options: EngineOptions = {},
): Promise<WriteResult> {
  return guarded(async () => {
    await assertScope(sql, ctx);
    const { bookingId, body: rawBody } = splitBookingId(rawInput);
    const body = parseOrThrow(confirmBookingSchema, rawBody);
    const cfg = await loadConfig(sql, ctx, options);
    return withIdempotency(sql, ctx, "confirm_booking", { bookingId, ...body }, async () => {
      const row = await loadBooking(sql, ctx, bookingId, { lock: true });
      assertVersion(row, body.expectedVersion);

      if (row.status === BookingStatus.EXPIRED) throw new AppError(ErrorCode.HOLD_EXPIRED);
      if (row.status !== BookingStatus.HOLD) {
        // CONFIRMED -> CONFIRMED is the reschedule edge, not a second confirmation.
        assertTransition(cfg.machine, row.status, BookingStatus.CONFIRMED, "booking");
        throw new AppError(ErrorCode.INVALID_TRANSITION, undefined, { entity: "booking", from: row.status, to: BookingStatus.CONFIRMED });
      }
      assertTransition(cfg.machine, row.status, BookingStatus.CONFIRMED, "booking");

      const nowMs = ctx.now().getTime();
      if (row.hold_expires_at === null || row.hold_expires_at.getTime() <= nowMs) throw new AppError(ErrorCode.HOLD_EXPIRED);
      if ((await loadActiveAllocations(sql, ctx, bookingId)).length === 0) throw new AppError(ErrorCode.HOLD_EXPIRED);

      const customer = await resolveCustomer(sql, ctx, cfg, body);
      const service = row.catalogue_item_id ? await loadService(sql, ctx, row.catalogue_item_id, { requireAvailable: false }) : null;
      const depositPaise = depositFor(service, cfg);
      const snapshot = buildSnapshot(cfg, depositPaise, ctx.now());

      await sql.query(
        `update bookings
            set status = 'CONFIRMED', customer_id = $3, notes = coalesce($4, notes), hold_expires_at = null,
                confirmed_at = $5, policy_snapshot = $6::jsonb, deposit_paise = $7, deposit_status = 'unpaid',
                version = version + 1, updated_at = now()
          where tenant_id = $1 and id = $2`,
        [ctx.tenantId, bookingId, customer.id, body.notes ?? null, ctx.now().toISOString(), JSON.stringify(snapshot), depositPaise],
      );
      const view = toView(await loadBooking(sql, ctx, bookingId));
      await recordChange(sql, ctx, BookingAuditAction.CONFIRM, view, row.status, { customerCreated: customer.created, depositPaise });
      return { booking: view };
    });
  });
}
