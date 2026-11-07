// Who is calling, and for whom. The channel layer sets `ctx.actor.channel` and, for a verified end customer,
// `ctx.subject.customerId` (from the verified contact, never from tool arguments).
//
// Policy (fail closed), the same as engine-bookings (src/access.ts):
//  * web_chat, whatsapp, voice are CUSTOMER channels. They may only draft, view, place and cancel THEIR OWN orders, and
//    every such call needs `ctx.subject.customerId`. Missing subject, an order of someone else, an order with no customer
//    and a non-existent order all give the same NOT_FOUND body. Staff operations (accept/prepare/fulfil/reject, edits,
//    discounts, payments, refunds, payment lists, board) are FORBIDDEN on these channels.
//  * dashboard (staff) and api (a trusted server integration with its own credential, acting for the tenant) are not
//    restricted by any of this; the API enforces their permissions and tool scopes. A subject on those channels is ignored.
//    capOverride is still accepted only from the dashboard.
import { AppError, Channel, ErrorCode, type EngineContext } from "@qenbel/shared";
import { notFound, orderError } from "./common.ts";

const CUSTOMER_CHANNELS: readonly Channel[] = [Channel.WEB_CHAT, Channel.WHATSAPP, Channel.VOICE];

export function isCustomerChannel(ctx: EngineContext): boolean {
  // Fail closed: anything that is not an explicitly trusted channel is treated as a customer channel.
  return !(ctx.actor.channel === Channel.DASHBOARD || ctx.actor.channel === Channel.API);
}

export function subjectCustomerId(ctx: EngineContext): string | undefined {
  const id = ctx.subject?.customerId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** True when this call runs on behalf of an end customer (a customer channel). */
export function actsForCustomer(ctx: EngineContext): boolean {
  return isCustomerChannel(ctx);
}

/** Operations only trusted staff or an unscoped integration may call. */
export function requireStaff(ctx: EngineContext, operation: string): void {
  if (actsForCustomer(ctx)) {
    throw new AppError(ErrorCode.FORBIDDEN, undefined, { reason: "CHANNEL_NOT_ALLOWED", operation });
  }
}

/** The verified customer for a customer-scoped create/list, or FORBIDDEN. Only call when actsForCustomer(ctx). */
export function requireSubject(ctx: EngineContext): string {
  const id = subjectCustomerId(ctx);
  if (id === undefined) throw orderError(ErrorCode.FORBIDDEN, "CUSTOMER_REQUIRED", "Identify the customer first.");
  return id;
}

/**
 * Ownership of an existing order. Staff (not acting for a customer) pass. A customer call passes only if the order's
 * customer is the verified subject; anything else is the one indistinguishable NOT_FOUND.
 */
export function assertOwnsOrder(ctx: EngineContext, order: { customer_id: string | null }): void {
  if (!actsForCustomer(ctx)) return;
  const subject = subjectCustomerId(ctx);
  if (subject === undefined || order.customer_id === null || order.customer_id !== subject) throw notFound("ORDER_NOT_FOUND");
}

/** Server-side limits per caller kind. The shared schema allows more; these are what the engine enforces. */
export interface Limits {
  maxLines: number;
  maxQuantityPerLine: number;
  maxUnits: number;
  maxListLimit: number;
}

export function limitsFor(ctx: EngineContext): Limits {
  return actsForCustomer(ctx)
    ? { maxLines: 50, maxQuantityPerLine: 99, maxUnits: 500, maxListLimit: 25 }
    : { maxLines: 100, maxQuantityPerLine: 999, maxUnits: 5000, maxListLimit: 100 };
}
