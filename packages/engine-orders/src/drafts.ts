// Draft orders: create (idempotent), edit lines, discount, fulfilment, notes. Prices come ONLY from the catalogue.
// Every function: parse strict input, prove the tenant session, lock the order row, check the version, change, reprice,
// write an audit row. The discount spec is persisted on the order and recomputed after every line change; line tax
// rates are frozen on the lines when they are added (see README).
import { toPaise } from "@qenbel/db";
import {
  Channel,
  ErrorCode,
  FulfilmentType,
  OrderStatus,
  type EngineContext,
  type SqlClient,
} from "@qenbel/shared";
import {
  assertTenantSession,
  audit,
  mapPgError,
  money,
  notFound,
  orderError,
  parseInput,
  withIdempotency,
} from "./common.ts";
import {
  defaultLocationId,
  requireBooking,
  requireCustomer,
  requireTable,
  resolveLines,
  type ResolvedLine,
} from "./lookups.ts";
import { loadPackContext } from "./pack.ts";
import { actsForCustomer, limitsFor, requireStaff, requireSubject, subjectCustomerId } from "./scope.ts";
import {
  MAX_LINES_PER_ORDER,
  MAX_QUANTITY_PER_LINE,
  addItemInputSchema,
  applyDiscountInputSchema,
  createOrderDraftInputSchema,
  removeDiscountInputSchema,
  removeItemInputSchema,
  setFulfilmentInputSchema,
  updateItemInputSchema,
  updateOrderNotesInputSchema,
  type AddItemInput,
  type ApplyDiscountInput,
  type CreateOrderDraftInput,
  type RemoveDiscountInput,
  type RemoveItemInput,
  type SetFulfilmentInput,
  type UpdateItemInput,
  type UpdateOrderNotesInput,
} from "./schemas.ts";
import { DISCOUNT_APPROVAL_CAP_BPS, ORDER_ROUNDING_MODE, computeTotals, discountAmount, discountBpsOfSubtotal } from "./totals.ts";
import { buildOrderView, loadItemRows, loadOrderRow, type ItemRow, type OrderRow, type OrderView } from "./view.ts";
import { assertDraft, bumpVersion, insertItem, invalidState, lockOrder, repriceDraft, upsertFulfilment } from "./write.ts";

export { DISCOUNT_APPROVAL_CAP_BPS };

/** Most drafts one verified customer can start in 24 hours on a customer channel. */
export const MAX_DRAFTS_PER_CUSTOMER_PER_DAY = 20;

/** Fulfilment details may change until preparation starts. */
const FULFILMENT_EDITABLE: readonly OrderStatus[] = [OrderStatus.DRAFT, OrderStatus.PLACED, OrderStatus.ACCEPTED];

function lineKey(l: { catalogueItemId: string; variantId: string | null; note: string | null; unitPricePaise: number; taxRateBps: number }): string {
  return `${l.catalogueItemId}|${l.variantId ?? ""}|${l.note ?? ""}|${l.unitPricePaise}|${l.taxRateBps}`;
}

/** Same item, variant, note, price and frozen tax rate become one line. */
function mergeLines(lines: ResolvedLine[], maxQuantity: number): ResolvedLine[] {
  const merged = new Map<string, ResolvedLine>();
  for (const line of lines) {
    const key = lineKey(line);
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += line.quantity;
      if (existing.quantity > maxQuantity) {
        throw orderError(ErrorCode.VALIDATION_FAILED, "QUANTITY_LIMIT", `At most ${maxQuantity} of one item.`);
      }
    } else {
      merged.set(key, { ...line });
    }
  }
  return [...merged.values()];
}

function assertSameCurrency(currency: string, lines: readonly ResolvedLine[]): void {
  for (const l of lines) {
    if (l.currency !== currency) {
      throw orderError(ErrorCode.VALIDATION_FAILED, "CURRENCY_MISMATCH", "All items in an order must use one currency.");
    }
  }
}

async function assertBookingLink(sql: SqlClient, ctx: EngineContext, bookingId: string, customerId: string | null): Promise<void> {
  const booking = await requireBooking(sql, ctx, bookingId);
  if (customerId && booking.customerId && booking.customerId !== customerId) {
    throw orderError(ErrorCode.CONFLICT, "BOOKING_CUSTOMER_MISMATCH", "That booking belongs to a different customer.");
  }
}

async function finish(sql: SqlClient, ctx: EngineContext, orderId: string, notices: string[] = []): Promise<OrderView> {
  const packCtx = await loadPackContext(sql, ctx, false);
  return buildOrderView(sql, ctx, packCtx, await loadOrderRow(sql, ctx, orderId, false), notices);
}

// ---- create ---------------------------------------------------------------------------------------------

/**
 * Create a DRAFT. Idempotent on ctx.idempotencyKey: the same key with the same input returns the same order (also for
 * concurrent duplicates); the same key with different input is IDEMPOTENCY_CONFLICT. Items are ids and quantities
 * only: the engine prices every line from the catalogue and snapshots name, price and tax onto it.
 */
export async function createOrderDraft(sql: SqlClient, ctx: EngineContext, rawInput: CreateOrderDraftInput): Promise<OrderView> {
  const input = parseInput(createOrderDraftInputSchema, rawInput);
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  // On a customer channel the order belongs to the verified subject. No subject, no draft. A customer id in the input
  // may only repeat the subject's own.
  const forCustomer = actsForCustomer(ctx);
  const subject = forCustomer ? requireSubject(ctx) : undefined;
  if (subject !== undefined && input.customerId !== undefined && input.customerId !== subject) throw notFound("CUSTOMER_NOT_FOUND");
  const owner = subject ?? input.customerId;
  const limits = limitsFor(ctx);
  try {
    return await withIdempotency(
      sql,
      ctx,
      "engine:orders:createOrderDraft",
      input,
      async () => {
        if (input.items.some((i) => i.quantity > limits.maxQuantityPerLine)) {
          throw orderError(ErrorCode.VALIDATION_FAILED, "QUANTITY_LIMIT", `At most ${limits.maxQuantityPerLine} of one item.`);
        }
        const lines = mergeLines(await resolveLines(sql, ctx, input.items), limits.maxQuantityPerLine);
        if (lines.length > limits.maxLines) {
          throw orderError(ErrorCode.VALIDATION_FAILED, "LINE_LIMIT", `At most ${limits.maxLines} lines.`);
        }
        if (lines.reduce((n, l) => n + l.quantity, 0) > limits.maxUnits) {
          throw orderError(ErrorCode.VALIDATION_FAILED, "UNIT_LIMIT", `At most ${limits.maxUnits} items in one order.`);
        }
        const currency = (lines[0] as ResolvedLine).currency;
        assertSameCurrency(currency, lines);

        if (owner) await requireCustomer(sql, ctx, owner);
        if (input.bookingId) {
          if (forCustomer) {
            // A customer may only link their own booking; anyone else's looks absent.
            const booking = await requireBooking(sql, ctx, input.bookingId);
            if (booking.customerId !== owner) throw notFound("BOOKING_NOT_FOUND");
          } else {
            await assertBookingLink(sql, ctx, input.bookingId, owner ?? null);
          }
        }
        if (forCustomer && owner) {
          // A draft is cheap to make and never expires: cap how many one customer can open per day.
          const recent = await sql.query<{ n: string }>(
            "select count(*) as n from orders where tenant_id = $1 and customer_id = $2 and created_at > $3::timestamptz - interval '24 hours'",
            [ctx.tenantId, owner, ctx.now()],
          );
          if (Number(recent.rows[0]?.n ?? 0) >= MAX_DRAFTS_PER_CUSTOMER_PER_DAY) {
            throw orderError(ErrorCode.RATE_LIMITED, "DRAFT_LIMIT", "Too many orders started today. Try again later.");
          }
        }

        let impliedTable: string | undefined;
        if (input.resourceId) {
          impliedTable = (await requireTable(sql, ctx, input.resourceId)).id;
          if (input.fulfilment && input.fulfilment.type !== FulfilmentType.DINE_IN) {
            throw orderError(ErrorCode.VALIDATION_FAILED, "TABLE_CONFLICT", "A table only goes with a dine-in order.");
          }
        }

        const totals = money(() => computeTotals(lines, null));
        const orderId = ctx.newId();
        const locationId = await defaultLocationId(sql, ctx);
        await sql.query(
          `insert into orders
             (id, tenant_id, location_id, customer_id, booking_id, conversation_id, status, source_channel, payment_status,
              subtotal_paise, tax_paise, discount_paise, total_paise, currency, notes)
           values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, 'unpaid', $8, $9, 0, $10, $11, $12)`,
          [
            orderId,
            ctx.tenantId,
            locationId,
            owner ?? null,
            input.bookingId ?? null,
            ctx.subject?.conversationId ?? null,
            ctx.actor.channel,
            totals.subtotalPaise,
            totals.taxPaise,
            totals.totalPaise,
            currency,
            input.notes && input.notes.length > 0 ? input.notes : null,
          ],
        );
        for (let i = 0; i < lines.length; i++) {
          await insertItem(sql, ctx, orderId, lines[i] as ResolvedLine, (totals.lines[i] as { taxPaise: number }).taxPaise);
        }
        if (input.fulfilment) {
          await upsertFulfilment(sql, ctx, orderId, input.fulfilment, impliedTable);
        } else if (impliedTable) {
          await upsertFulfilment(sql, ctx, orderId, { type: FulfilmentType.DINE_IN, resourceId: impliedTable }, impliedTable);
        }
        await audit(sql, ctx, "order.draft_created", "order", orderId, {
          lines: lines.length,
          subtotalPaise: totals.subtotalPaise,
          totalPaise: totals.totalPaise,
          subjectCustomerId: subjectCustomerId(ctx) ?? null,
        });
        return orderId;
      },
      (orderId) => finish(sql, ctx, orderId),
    );
  } catch (err) {
    return mapPgError(err);
  }
}

// ---- lines ---------------------------------------------------------------------------------------------

/**
 * Reprice after a line change. The stored discount spec is recomputed on the new subtotal; it is dropped (notice
 * DISCOUNT_CLEARED) only if it became invalid: a fixed amount above the new subtotal, or above the cap without approval.
 */
async function repriceAndView(sql: SqlClient, ctx: EngineContext, order: OrderRow, action: string, details: Record<string, unknown>): Promise<OrderView> {
  const units = await sql.query<{ n: string }>("select coalesce(sum(quantity), 0) as n from order_items where tenant_id = $1 and order_id = $2", [ctx.tenantId, order.id]);
  if (Number(units.rows[0]?.n ?? 0) > limitsFor(ctx).maxUnits) {
    throw orderError(ErrorCode.VALIDATION_FAILED, "UNIT_LIMIT", `At most ${limitsFor(ctx).maxUnits} items in one order.`);
  }
  const { order: updated, discountCleared } = await repriceDraft(sql, ctx, order);
  const notices = discountCleared ? ["DISCOUNT_CLEARED"] : [];
  await audit(sql, ctx, action, "order", order.id, {
    ...details,
    discountCleared,
    discountPaise: toPaise(updated.discount_paise),
    totalPaise: toPaise(updated.total_paise),
  });
  const packCtx = await loadPackContext(sql, ctx, false);
  return buildOrderView(sql, ctx, packCtx, updated, notices);
}

/** Add a line to a draft. The same item/variant/note/price merges into the existing line (quantity capped at 999). */
export async function addItem(sql: SqlClient, ctx: EngineContext, rawInput: AddItemInput): Promise<OrderView> {
  const input = parseInput(addItemInputSchema, rawInput);
  requireStaff(ctx, "addItem");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    const [line] = await resolveLines(sql, ctx, [input.item]);
    const resolved = line as ResolvedLine;
    assertSameCurrency(order.currency, [resolved]);
    const items = await loadItemRows(sql, ctx, order.id);
    const match = items.find(
      (i) =>
        lineKey({
          catalogueItemId: i.catalogue_item_id ?? "",
          variantId: i.variant_id,
          note: i.notes,
          unitPricePaise: toPaise(i.unit_price_paise),
          taxRateBps: i.tax_rate_bps,
        }) === lineKey(resolved),
    );
    if (match) {
      const quantity = match.quantity + resolved.quantity;
      if (quantity > MAX_QUANTITY_PER_LINE) {
        throw orderError(ErrorCode.VALIDATION_FAILED, "QUANTITY_LIMIT", `At most ${MAX_QUANTITY_PER_LINE} of one item.`);
      }
      const linePaise = money(() => toPaise(match.unit_price_paise) * quantity);
      await sql.query("update order_items set quantity = $3, line_total_paise = $4 where tenant_id = $1 and id = $2", [
        ctx.tenantId,
        match.id,
        quantity,
        linePaise,
      ]);
    } else {
      if (items.length >= MAX_LINES_PER_ORDER) {
        throw orderError(ErrorCode.VALIDATION_FAILED, "LINE_LIMIT", `At most ${MAX_LINES_PER_ORDER} lines.`);
      }
      await insertItem(sql, ctx, order.id, resolved, 0);
    }
    return await repriceAndView(sql, ctx, order, "order.item_added", { catalogueItemId: resolved.catalogueItemId, quantity: resolved.quantity });
  } catch (err) {
    return mapPgError(err);
  }
}

async function requireOrderItem(sql: SqlClient, ctx: EngineContext, orderId: string, itemId: string): Promise<ItemRow> {
  const items = await loadItemRows(sql, ctx, orderId);
  const item = items.find((i) => i.id === itemId);
  if (!item) throw notFound("ORDER_ITEM_NOT_FOUND");
  return item;
}

/** Change a line's quantity or note. The unit price is never touched: it stays the snapshot taken when it was added. */
export async function updateItem(sql: SqlClient, ctx: EngineContext, rawInput: UpdateItemInput): Promise<OrderView> {
  const input = parseInput(updateItemInputSchema, rawInput);
  requireStaff(ctx, "updateItem");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    const item = await requireOrderItem(sql, ctx, order.id, input.itemId);
    const quantity = input.quantity ?? item.quantity;
    const note = input.note === undefined ? item.notes : input.note === null || input.note.length === 0 ? null : input.note;
    const linePaise = money(() => toPaise(item.unit_price_paise) * quantity);
    await sql.query("update order_items set quantity = $3, notes = $4, line_total_paise = $5 where tenant_id = $1 and id = $2", [
      ctx.tenantId,
      item.id,
      quantity,
      note,
      linePaise,
    ]);
    return await repriceAndView(sql, ctx, order, "order.item_updated", { itemId: item.id, quantity });
  } catch (err) {
    return mapPgError(err);
  }
}

export async function removeItem(sql: SqlClient, ctx: EngineContext, rawInput: RemoveItemInput): Promise<OrderView> {
  const input = parseInput(removeItemInputSchema, rawInput);
  requireStaff(ctx, "removeItem");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    const item = await requireOrderItem(sql, ctx, order.id, input.itemId);
    await sql.query("delete from order_items where tenant_id = $1 and id = $2", [ctx.tenantId, item.id]);
    return await repriceAndView(sql, ctx, order, "order.item_removed", { itemId: item.id });
  } catch (err) {
    return mapPgError(err);
  }
}

export async function updateOrderNotes(sql: SqlClient, ctx: EngineContext, rawInput: UpdateOrderNotesInput): Promise<OrderView> {
  const input = parseInput(updateOrderNotesInputSchema, rawInput);
  requireStaff(ctx, "updateOrderNotes");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    const notes = input.notes === null || input.notes.length === 0 ? null : input.notes;
    const res = await sql.query<OrderRow>(
      "update orders set notes = $3, version = version + 1 where tenant_id = $1 and id = $2 returning *",
      [ctx.tenantId, order.id, notes],
    );
    await audit(sql, ctx, "order.notes_updated", "order", order.id, {});
    const packCtx = await loadPackContext(sql, ctx, false);
    return await buildOrderView(sql, ctx, packCtx, res.rows[0] as OrderRow);
  } catch (err) {
    return mapPgError(err);
  }
}

// ---- discount ---------------------------------------------------------------------------------------------

/**
 * Apply a discount to a draft (replaces any earlier one). The spec (fixed paise or percent bps), the reason and whether
 * the cap was overridden are stored on the order, so later line edits recompute the amount. Hard rule: never more than the subtotal. Policy cap:
 * above DISCOUNT_APPROVAL_CAP_BPS of the subtotal it needs `capOverride: true`, which the API sets only for a
 * principal with the override permission. Who, how much and whether the override was used go to the audit log.
 */
export async function applyDiscount(sql: SqlClient, ctx: EngineContext, rawInput: ApplyDiscountInput): Promise<OrderView> {
  const input = parseInput(applyDiscountInputSchema, rawInput);
  requireStaff(ctx, "applyDiscount");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    const items = await loadItemRows(sql, ctx, order.id);
    if (items.length === 0) throw orderError(ErrorCode.VALIDATION_FAILED, "ORDER_EMPTY", "Add an item before a discount.");
    const subtotal = items.reduce((acc, i) => acc + toPaise(i.line_total_paise), 0);
    const spec = input.kind === "fixed" ? ({ kind: "fixed", amountPaise: input.amountPaise } as const) : ({ kind: "percent", bps: input.bps } as const);
    const amount = money(() => discountAmount(subtotal, spec, ORDER_ROUNDING_MODE));
    const effectiveBps = discountBpsOfSubtotal(amount, subtotal);
    const overCap = effectiveBps > DISCOUNT_APPROVAL_CAP_BPS;
    const overrideFlag = input.capOverride === true;
    // An override is a staff decision made on the dashboard; no other channel can ever carry it.
    if (overrideFlag && ctx.actor.channel !== Channel.DASHBOARD) {
      throw orderError(ErrorCode.FORBIDDEN, "CAP_OVERRIDE_NOT_ALLOWED", "Only staff on the dashboard can approve this discount.");
    }
    if (overCap && !overrideFlag) {
      throw orderError(ErrorCode.FORBIDDEN, "DISCOUNT_CAP_EXCEEDED", "That discount needs approval.", { capBps: DISCOUNT_APPROVAL_CAP_BPS });
    }
    const { order: updated } = await repriceDraft(sql, ctx, order, {
      discount: { spec, reason: input.reason ?? null, capOverride: overCap && overrideFlag },
    });
    await audit(sql, ctx, "order.discount_applied", "order", order.id, {
      kind: input.kind,
      value: input.kind === "fixed" ? input.amountPaise : input.bps,
      discountPaise: amount,
      effectiveBps,
      capBps: DISCOUNT_APPROVAL_CAP_BPS,
      capOverrideFlag: overrideFlag,
      capOverrideNeeded: overCap,
      rounding: ORDER_ROUNDING_MODE,
      reason: input.reason ?? null,
    });
    const packCtx = await loadPackContext(sql, ctx, false);
    return await buildOrderView(sql, ctx, packCtx, updated);
  } catch (err) {
    return mapPgError(err);
  }
}

export async function removeDiscount(sql: SqlClient, ctx: EngineContext, rawInput: RemoveDiscountInput): Promise<OrderView> {
  const input = parseInput(removeDiscountInputSchema, rawInput);
  requireStaff(ctx, "removeDiscount");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    assertDraft(order);
    if (order.discount_type === null && toPaise(order.discount_paise) === 0) return await finish(sql, ctx, order.id);
    const { order: updated } = await repriceDraft(sql, ctx, order, { discount: null });
    await audit(sql, ctx, "order.discount_removed", "order", order.id, { totalPaise: toPaise(updated.total_paise) });
    const packCtx = await loadPackContext(sql, ctx, false);
    return await buildOrderView(sql, ctx, packCtx, updated);
  } catch (err) {
    return mapPgError(err);
  }
}

// ---- fulfilment ---------------------------------------------------------------------------------------------

/**
 * Set how the order is handed over: pickup, delivery (address), dine_in (table resource or label) or on_site, plus an
 * optional link to a booking. The link is only a reference: orders and bookings stay separate records.
 */
export async function setFulfilment(sql: SqlClient, ctx: EngineContext, rawInput: SetFulfilmentInput): Promise<OrderView> {
  const input = parseInput(setFulfilmentInputSchema, rawInput);
  requireStaff(ctx, "setFulfilment");
  await assertTenantSession(sql, ctx);
  await loadPackContext(sql, ctx, true);
  try {
    const order = await lockOrder(sql, ctx, input.orderId, input.expectedVersion);
    if (!FULFILMENT_EDITABLE.includes(order.status)) throw invalidState(order, "fulfilment can no longer change");
    await upsertFulfilment(sql, ctx, order.id, input.fulfilment);
    if (input.bookingId !== undefined) {
      if (input.bookingId !== null) await assertBookingLink(sql, ctx, input.bookingId, order.customer_id);
      await sql.query("update orders set booking_id = $3 where tenant_id = $1 and id = $2", [ctx.tenantId, order.id, input.bookingId]);
    }
    const updated = await bumpVersion(sql, ctx, order);
    await audit(sql, ctx, "order.fulfilment_set", "order", order.id, {
      type: input.fulfilment.type,
      bookingId: input.bookingId ?? null,
    });
    const packCtx = await loadPackContext(sql, ctx, false);
    return await buildOrderView(sql, ctx, packCtx, updated);
  } catch (err) {
    return mapPgError(err);
  }
}
