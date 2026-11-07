// Order lifecycle: every status change goes through the tenant's pack-narrowed machine with the optimistic version.
// One central function (`applyTransition`) owns the side effects; the named functions are thin wrappers.
import { toPaise } from "@qenbel/db";
import {
  AppError,
  ErrorCode,
  FulfilmentStatus,
  OrderStatus,
  PaymentKind,
  PaymentMethod,
  assertTransition,
  canTransition,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import { assertTenantSession, audit, emitEvent, mapPgError, notFound, orderError, parseInput } from "./common.ts";
import { insertLedgerEntry, refreshPaymentStatus } from "./ledger-db.ts";
import { netPaidPaise } from "./ledger.ts";
import { assertLinesStillOrderable, findOrCreateCustomer, missingCustomerFields, requireBooking, requireCustomer, type CustomerRow } from "./lookups.ts";
import { loadPackContext, type PackContext } from "./pack.ts";
import {
  cancelOrderInputSchema,
  placeOrderInputSchema,
  rejectOrderInputSchema,
  stepOrderInputSchema,
  transitionOrderInputSchema,
  type CancelOrderInput,
  type PlaceOrderInput,
  type RejectOrderInput,
  type StepOrderInput,
  type TransitionOrderInput,
} from "./schemas.ts";
import { buildOrderView, loadItemRows, loadLedgerSums, type OrderRow, type OrderView } from "./view.ts";
import { lockOrder } from "./write.ts";

interface TransitionOptions {
  reason?: string | undefined;
  refundMethod?: PaymentMethod | undefined;
  /** Customer chosen at placement (DRAFT -> PLACED only). */
  placeCustomer?: CustomerRow | null | undefined;
}

function eventPayload(order: OrderRow, previous: OrderStatus, ctx: EngineContext, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: order.id,
    reference: order.reference,
    status: order.status,
    previousStatus: previous,
    version: order.version,
    totalPaise: toPaise(order.total_paise),
    currency: order.currency,
    paymentStatus: order.payment_status,
    customerId: order.customer_id,
    source: order.source_channel,
    occurredAt: ctx.now().toISOString(),
    ...extra,
  };
}

/** Throws unless the order belongs to the customer the channel layer verified. Never reveals that the order exists. */
function assertOwner(order: OrderRow, onBehalfOfCustomerId: string | undefined): void {
  if (onBehalfOfCustomerId !== undefined && order.customer_id !== onBehalfOfCustomerId) throw notFound("ORDER_NOT_FOUND");
}

/**
 * Move a locked order to `to`. Checks the pack machine (INVALID_TRANSITION), runs the side effects of the target
 * status, bumps the version, writes the audit row and queues the webhook event, all in the caller's transaction.
 */
async function applyTransition(
  sql: SqlClient,
  ctx: EngineContext,
  packCtx: PackContext,
  order: OrderRow,
  to: OrderStatus,
  opts: TransitionOptions = {},
): Promise<OrderView> {
  assertTransition(packCtx.machine, order.status, to, "order");
  const previous = order.status;
  const now = ctx.now();
  let customerId = order.customer_id;
  let placedAt: Date | null = null;
  let fulfilledAt: Date | null = null;
  let cancelledAt: Date | null = null;
  let cancellationReason: string | null = null;
  let refundEntryMade = false;

  switch (to) {
    case OrderStatus.PLACED: {
      const items = await loadItemRows(sql, ctx, order.id);
      if (items.length === 0) throw orderError(ErrorCode.VALIDATION_FAILED, "ORDER_EMPTY", "The order has no items.");
      const customer = opts.placeCustomer ?? null;
      const required = packCtx.pack?.requiredCustomerFields ?? [];
      const missing = missingCustomerFields(required, customer);
      if (missing.length > 0) {
        throw orderError(ErrorCode.REQUIRED_FIELDS_MISSING, "ORDER_REQUIRED_FIELDS_MISSING", undefined, { missing });
      }
      await assertLinesStillOrderable(sql, ctx, items);
      if (order.booking_id && customer) {
        const booking = await requireBooking(sql, ctx, order.booking_id);
        if (booking.customerId && booking.customerId !== customer.id) {
          throw orderError(ErrorCode.CONFLICT, "BOOKING_CUSTOMER_MISMATCH", "The linked booking belongs to a different customer.");
        }
      }
      customerId = customer?.id ?? null;
      placedAt = now;
      break;
    }
    case OrderStatus.PROCESSING:
      await sql.query("update fulfilments set status = $3 where tenant_id = $1 and order_id = $2 and status in ('pending','scheduled')", [
        ctx.tenantId,
        order.id,
        FulfilmentStatus.IN_PROGRESS,
      ]);
      break;
    case OrderStatus.FULFILLED:
      fulfilledAt = now;
      await sql.query("update fulfilments set status = $3, completed_at = $4 where tenant_id = $1 and order_id = $2 and status not in ('cancelled','failed')", [
        ctx.tenantId,
        order.id,
        FulfilmentStatus.COMPLETED,
        now,
      ]);
      break;
    case OrderStatus.CANCELLED:
    case OrderStatus.REJECTED: {
      cancelledAt = now;
      cancellationReason = opts.reason && opts.reason.length > 0 ? opts.reason : null;
      await sql.query("update fulfilments set status = $3 where tenant_id = $1 and order_id = $2 and status not in ('completed','failed')", [
        ctx.tenantId,
        order.id,
        FulfilmentStatus.CANCELLED,
      ]);
      // A paid order that is cancelled or rejected before fulfilment keeps its history and gains a refund entry.
      const sums = await loadLedgerSums(sql, ctx, order.id);
      const held = netPaidPaise(sums);
      if (held > 0) {
        await insertLedgerEntry(sql, ctx, order, {
          kind: PaymentKind.REFUND,
          method: opts.refundMethod ?? PaymentMethod.OTHER,
          amountPaise: held,
          note: to === OrderStatus.CANCELLED ? "Refund on cancellation" : "Refund on rejection",
        });
        refundEntryMade = true;
      }
      break;
    }
    case OrderStatus.REFUNDED: {
      // Reachable from FULFILLED only (the machine enforces it) and only once the ledger is fully refunded.
      const sums = await loadLedgerSums(sql, ctx, order.id);
      if (sums.paidPaise === 0 || netPaidPaise(sums) !== 0) {
        throw orderError(ErrorCode.CONFLICT, "REFUND_REQUIRED", "Record the full refund first.");
      }
      break;
    }
    default:
      break;
  }

  const res = await sql.query<OrderRow>(
    `update orders
        set status = $3, version = version + 1, customer_id = $4,
            placed_at = coalesce($5, placed_at), fulfilled_at = coalesce($6, fulfilled_at),
            cancelled_at = coalesce($7, cancelled_at), cancellation_reason = coalesce($8, cancellation_reason)
      where tenant_id = $1 and id = $2 and version = $9
      returning *`,
    [ctx.tenantId, order.id, to, customerId, placedAt, fulfilledAt, cancelledAt, cancellationReason, order.version],
  );
  let updated = res.rows[0];
  if (!updated) throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { reason: "ORDER_VERSION_CONFLICT" });
  updated = await refreshPaymentStatus(sql, ctx, updated);

  await audit(sql, ctx, `order.${to.toLowerCase()}`, "order", order.id, {
    from: previous,
    to,
    version: updated.version,
    reason: opts.reason ?? null,
    refundEntryMade,
  });

  switch (to) {
    case OrderStatus.PLACED:
      await emitEvent(sql, ctx, "order.created", { aggregateType: "order", aggregateId: order.id, payload: eventPayload(updated, previous, ctx) });
      break;
    case OrderStatus.ACCEPTED:
      await emitEvent(sql, ctx, "order.accepted", { aggregateType: "order", aggregateId: order.id, payload: eventPayload(updated, previous, ctx) });
      break;
    case OrderStatus.FULFILLED:
      await emitEvent(sql, ctx, "order.fulfilled", { aggregateType: "order", aggregateId: order.id, payload: eventPayload(updated, previous, ctx) });
      break;
    case OrderStatus.CANCELLED:
    case OrderStatus.REJECTED:
      // The webhook vocabulary has no order.rejected; payload.status says which it was. A draft was never announced
      // (order.created is sent at placement), so cancelling one sends nothing.
      if (previous !== OrderStatus.DRAFT) {
        await emitEvent(sql, ctx, "order.cancelled", {
          aggregateType: "order",
          aggregateId: order.id,
          payload: eventPayload(updated, previous, ctx, { reason: opts.reason ?? null }),
        });
      }
      break;
    default:
      break;
  }
  return buildOrderView(sql, ctx, packCtx, updated);
}

/** Used by the ledger: a fully refunded FULFILLED order moves to REFUNDED when the pack allows it. */
export async function moveToRefundedIfFullyRefunded(
  sql: SqlClient,
  ctx: EngineContext,
  packCtx: PackContext,
  order: OrderRow,
): Promise<OrderRow | null> {
  if (order.status !== OrderStatus.FULFILLED || !canTransition(packCtx.machine, OrderStatus.FULFILLED, OrderStatus.REFUNDED)) return null;
  const sums = await loadLedgerSums(sql, ctx, order.id);
  if (sums.paidPaise === 0 || netPaidPaise(sums) !== 0) return null;
  const res = await sql.query<OrderRow>(
    "update orders set status = 'REFUNDED', version = version + 1 where tenant_id = $1 and id = $2 and version = $3 returning *",
    [ctx.tenantId, order.id, order.version],
  );
  const updated = res.rows[0];
  if (!updated) throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, { reason: "ORDER_VERSION_CONFLICT" });
  await audit(sql, ctx, "order.refunded", "order", order.id, { from: OrderStatus.FULFILLED, to: OrderStatus.REFUNDED, version: updated.version });
  return updated;
}

async function run(
  sql: SqlClient,
  ctx: EngineContext,
  orderId: string,
  expectedVersion: number | undefined,
  to: OrderStatus,
  opts: TransitionOptions & { onBehalfOfCustomerId?: string | undefined } = {},
): Promise<OrderView> {
  await assertTenantSession(sql, ctx);
  const packCtx = await loadPackContext(sql, ctx, true);
  try {
    // Lock first so concurrent callers queue; ownership is checked before the version so a foreign order looks absent.
    const order = await lockOrder(sql, ctx, orderId, undefined);
    assertOwner(order, opts.onBehalfOfCustomerId);
    if (expectedVersion !== undefined && order.version !== expectedVersion) {
      throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, {
        reason: "ORDER_VERSION_CONFLICT",
        expectedVersion,
        currentVersion: order.version,
      });
    }
    return await applyTransition(sql, ctx, packCtx, order, to, opts);
  } catch (err) {
    return mapPgError(err);
  }
}

// ---- named operations ---------------------------------------------------------------------------------------

/**
 * DRAFT -> PLACED. Needs at least one line, every line still orderable, and the pack's required customer fields on
 * the customer (existing `customerId`, an inline `customer` that is found by phone/email or created, or the order's
 * own customer). Totals are frozen from here on. Queues `order.created`.
 */
export async function placeOrder(sql: SqlClient, ctx: EngineContext, rawInput: PlaceOrderInput): Promise<OrderView> {
  const input = parseInput(placeOrderInputSchema, rawInput);
  await assertTenantSession(sql, ctx);
  const packCtx = await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, undefined);
    assertOwner(order, input.onBehalfOfCustomerId);
    if (input.expectedVersion !== undefined && order.version !== input.expectedVersion) {
      throw new AppError(ErrorCode.VERSION_CONFLICT, undefined, {
        reason: "ORDER_VERSION_CONFLICT",
        expectedVersion: input.expectedVersion,
        currentVersion: order.version,
      });
    }
    assertTransition(packCtx.machine, order.status, OrderStatus.PLACED, "order");
    if (input.onBehalfOfCustomerId !== undefined && (input.customer !== undefined || (input.customerId !== undefined && input.customerId !== input.onBehalfOfCustomerId))) {
      throw orderError(ErrorCode.VALIDATION_FAILED, "CUSTOMER_CHANGE_NOT_ALLOWED", "The customer on this order cannot be changed.");
    }
    let customer: CustomerRow | null = null;
    if (input.customerId !== undefined) customer = await requireCustomer(sql, ctx, input.customerId);
    else if (input.customer !== undefined) customer = await findOrCreateCustomer(sql, ctx, input.customer);
    else if (order.customer_id) customer = await requireCustomer(sql, ctx, order.customer_id);
    return await applyTransition(sql, ctx, packCtx, order, OrderStatus.PLACED, { placeCustomer: customer });
  } catch (err) {
    return mapPgError(err);
  }
}

export const acceptOrder = (sql: SqlClient, ctx: EngineContext, raw: StepOrderInput): Promise<OrderView> => {
  const input = parseInput(stepOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.ACCEPTED);
};

export const startProcessing = (sql: SqlClient, ctx: EngineContext, raw: StepOrderInput): Promise<OrderView> => {
  const input = parseInput(stepOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.PROCESSING);
};

export const markReady = (sql: SqlClient, ctx: EngineContext, raw: StepOrderInput): Promise<OrderView> => {
  const input = parseInput(stepOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.READY);
};

export const fulfil = (sql: SqlClient, ctx: EngineContext, raw: StepOrderInput): Promise<OrderView> => {
  const input = parseInput(stepOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.FULFILLED);
};

/** PLACED -> REJECTED (staff declines). A paid order also gets a refund ledger entry. Queues order.cancelled (status REJECTED). */
export const rejectOrder = (sql: SqlClient, ctx: EngineContext, raw: RejectOrderInput): Promise<OrderView> => {
  const input = parseInput(rejectOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.REJECTED, {
    reason: input.reason,
    refundMethod: input.refundMethod,
  });
};

/**
 * DRAFT | PLACED | ACCEPTED -> CANCELLED (as far as the pack allows). A paid order becomes CANCELLED plus a refund
 * entry for everything it holds. `onBehalfOfCustomerId` makes a foreign order look absent.
 */
export const cancelOrder = (sql: SqlClient, ctx: EngineContext, raw: CancelOrderInput): Promise<OrderView> => {
  const input = parseInput(cancelOrderInputSchema, raw);
  return run(sql, ctx, input.orderId, input.expectedVersion, OrderStatus.CANCELLED, {
    reason: input.reason,
    refundMethod: input.refundMethod,
    onBehalfOfCustomerId: input.onBehalfOfCustomerId,
  });
};

/**
 * Dashboard move to any status the pack allows next. PLACED is refused here: use placeOrder, which checks the customer
 * fields. REFUNDED needs the ledger to be fully refunded already.
 */
export async function transitionOrder(sql: SqlClient, ctx: EngineContext, raw: TransitionOrderInput): Promise<OrderView> {
  const input = parseInput(transitionOrderInputSchema, raw);
  if (input.to === OrderStatus.PLACED) {
    return placeOrder(sql, ctx, { orderId: input.orderId, expectedVersion: input.expectedVersion });
  }
  return run(sql, ctx, input.orderId, input.expectedVersion, input.to, { reason: input.reason, refundMethod: input.refundMethod });
}
