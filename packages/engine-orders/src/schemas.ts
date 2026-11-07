// Strict zod input schemas for every engine function. Unknown keys fail (a smuggled tenantId, role or price is
// VALIDATION_FAILED). No schema has a price, tax, total or tenant field: those are server-side only.
import { z } from "zod";
import {
  FulfilmentType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Channel,
  createCustomerSchema,
  createOrderDraftSchema,
  idSchema,
  instantSchema,
  listOrdersQuerySchema,
  orderItemInputSchema,
  plainText,
  versionSchema,
} from "@qenbel/shared";

/** Highest amount accepted on a single ledger entry (paise). */
export const MAX_ENTRY_PAISE = 1_000_000_000_000;
export const MAX_LINES_PER_ORDER = 100;
export const MAX_QUANTITY_PER_LINE = 999;

/** An order line request: which catalogue item (and variant), how many. The price is read server-side. */
export const orderLineInputSchema = orderItemInputSchema.extend({ variantId: idSchema.optional() });
export type OrderLineInput = z.infer<typeof orderLineInputSchema>;

const orderId = idSchema;
const expectedVersion = versionSchema;
const reason = plainText(300);
const paise = z.number().int().safe();

export const deliveryAddressSchema = z
  .object({
    line1: plainText(200).pipe(z.string().min(1)),
    line2: plainText(200).optional(),
    city: plainText(100).pipe(z.string().min(1)),
    state: plainText(100).optional(),
    postalCode: plainText(12).pipe(z.string().min(1)),
    landmark: plainText(200).optional(),
    contactPhone: plainText(20).optional(),
  })
  .strict();
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

const fulfilmentNotes = plainText(500);

export const fulfilmentInputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(FulfilmentType.PICKUP), scheduledFor: instantSchema.optional(), notes: fulfilmentNotes.optional() }).strict(),
  z
    .object({
      type: z.literal(FulfilmentType.DELIVERY),
      address: deliveryAddressSchema,
      scheduledFor: instantSchema.optional(),
      notes: fulfilmentNotes.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(FulfilmentType.DINE_IN),
      /** A table resource of this business. */
      resourceId: idSchema.optional(),
      /** Free label ("6", "Patio 2") when the table is not a resource. One of resourceId or tableLabel is required. */
      tableLabel: plainText(20).pipe(z.string().min(1)).optional(),
      notes: fulfilmentNotes.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal(FulfilmentType.ON_SITE),
      /** Where on site, as plain text ("Room 12"). */
      place: plainText(200).optional(),
      scheduledFor: instantSchema.optional(),
      notes: fulfilmentNotes.optional(),
    })
    .strict(),
]);
export type FulfilmentInput = z.infer<typeof fulfilmentInputSchema>;

/** create_order_draft. Idempotent on ctx.idempotencyKey. Shared fields come from @qenbel/shared. */
export const createOrderDraftInputSchema = createOrderDraftSchema.extend({
  items: z.array(orderLineInputSchema).min(1).max(MAX_LINES_PER_ORDER),
  fulfilment: fulfilmentInputSchema.optional(),
});
export type CreateOrderDraftInput = z.input<typeof createOrderDraftInputSchema>;

export const addItemInputSchema = z.object({ orderId, expectedVersion, item: orderLineInputSchema }).strict();
export type AddItemInput = z.input<typeof addItemInputSchema>;

export const updateItemInputSchema = z
  .object({
    orderId,
    expectedVersion,
    /** The order line id (not the catalogue item id). */
    itemId: idSchema,
    quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE).optional(),
    note: plainText(200).nullable().optional(),
  })
  .strict()
  .refine((v) => v.quantity !== undefined || v.note !== undefined, { message: "Provide quantity or note", path: ["quantity"] });
export type UpdateItemInput = z.input<typeof updateItemInputSchema>;

export const removeItemInputSchema = z.object({ orderId, expectedVersion, itemId: idSchema }).strict();
export type RemoveItemInput = z.input<typeof removeItemInputSchema>;

export const updateOrderNotesInputSchema = z.object({ orderId, expectedVersion, notes: plainText(1000).nullable() }).strict();
export type UpdateOrderNotesInput = z.input<typeof updateOrderNotesInputSchema>;

/**
 * Staff discount. `capOverride` is a PERMISSION FLAG: the API sets it only when the principal holds the
 * discount-override permission. It is never taken from a customer or from an AI tool call (no tool has this input).
 */
export const applyDiscountInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      orderId,
      expectedVersion,
      kind: z.literal("fixed"),
      amountPaise: paise.min(0).max(MAX_ENTRY_PAISE),
      reason: plainText(200).optional(),
      capOverride: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      orderId,
      expectedVersion,
      kind: z.literal("percent"),
      bps: z.number().int().min(0).max(10_000),
      reason: plainText(200).optional(),
      capOverride: z.boolean().optional(),
    })
    .strict(),
]);
export type ApplyDiscountInput = z.input<typeof applyDiscountInputSchema>;

export const removeDiscountInputSchema = z.object({ orderId, expectedVersion }).strict();
export type RemoveDiscountInput = z.input<typeof removeDiscountInputSchema>;

export const setFulfilmentInputSchema = z
  .object({
    orderId,
    expectedVersion,
    fulfilment: fulfilmentInputSchema,
    /** Optional link to a booking of this business. null unlinks. Orders and bookings stay separate records. */
    bookingId: idSchema.nullable().optional(),
  })
  .strict();
export type SetFulfilmentInput = z.input<typeof setFulfilmentInputSchema>;

export const placeOrderInputSchema = z
  .object({
    orderId,
    customerId: idSchema.optional(),
    customer: createCustomerSchema.optional(),
    expectedVersion: expectedVersion.optional(),
    /** Set by the channel layer for customer-facing calls: the order must belong to this customer. */
    onBehalfOfCustomerId: idSchema.optional(),
  })
  .strict()
  .refine((v) => v.customerId === undefined || v.customer === undefined, {
    message: "Provide customerId or customer, not both",
    path: ["customerId"],
  });
export type PlaceOrderInput = z.input<typeof placeOrderInputSchema>;

/** accept / start processing / ready / fulfil: staff actions that always carry the version they saw. */
export const stepOrderInputSchema = z.object({ orderId, expectedVersion }).strict();
export type StepOrderInput = z.input<typeof stepOrderInputSchema>;

export const rejectOrderInputSchema = z.object({ orderId, expectedVersion, reason: reason.optional(), refundMethod: z.enum(PaymentMethod).optional() }).strict();
export type RejectOrderInput = z.input<typeof rejectOrderInputSchema>;

export const cancelOrderInputSchema = z
  .object({
    orderId,
    expectedVersion: expectedVersion.optional(),
    reason: reason.optional(),
    /** Method recorded on the automatic refund entry when a paid order is cancelled. Default 'other'. */
    refundMethod: z.enum(PaymentMethod).optional(),
    /** Set by the channel layer for customer-facing calls: the order must belong to this customer. */
    onBehalfOfCustomerId: idSchema.optional(),
  })
  .strict();
export type CancelOrderInput = z.input<typeof cancelOrderInputSchema>;

/** Generic dashboard move. `to` is checked against the tenant's pack machine. */
export const transitionOrderInputSchema = z
  .object({
    orderId,
    to: z.enum(OrderStatus),
    expectedVersion,
    reason: reason.optional(),
    refundMethod: z.enum(PaymentMethod).optional(),
  })
  .strict();
export type TransitionOrderInput = z.input<typeof transitionOrderInputSchema>;

export const recordPaymentInputSchema = z
  .object({
    orderId,
    amountPaise: paise.min(1).max(MAX_ENTRY_PAISE),
    method: z.enum(PaymentMethod),
    note: plainText(1000).optional(),
    provider: plainText(60).pipe(z.string().min(1)).optional(),
    providerReference: plainText(200).pipe(z.string().min(1)).optional(),
  })
  .strict()
  .refine((v) => (v.provider === undefined) === (v.providerReference === undefined), {
    message: "provider and providerReference go together",
    path: ["providerReference"],
  });
export type RecordPaymentInput = z.input<typeof recordPaymentInputSchema>;

export const recordRefundInputSchema = z
  .object({
    orderId,
    amountPaise: paise.min(1).max(MAX_ENTRY_PAISE),
    method: z.enum(PaymentMethod),
    note: plainText(1000).optional(),
  })
  .strict();
export type RecordRefundInput = z.input<typeof recordRefundInputSchema>;

export const getOrderInputSchema = z.object({ orderId }).strict();
export type GetOrderInput = z.input<typeof getOrderInputSchema>;

export const listPaymentsInputSchema = z.object({ orderId }).strict();
export type ListPaymentsInput = z.input<typeof listPaymentsInputSchema>;

/**
 * Status for an AI or WhatsApp channel. `customerId` is resolved by the channel layer from the verified contact,
 * never from the model. Exactly one of orderId or orderReference.
 */
export const orderStatusForChannelInputSchema = z
  .object({
    customerId: idSchema,
    orderId: idSchema.optional(),
    orderReference: plainText(32).pipe(z.string().min(3)).optional(),
  })
  .strict()
  .refine((v) => (v.orderId === undefined) !== (v.orderReference === undefined), {
    message: "Provide orderId or orderReference",
    path: ["orderId"],
  });
export type OrderStatusForChannelInput = z.input<typeof orderStatusForChannelInputSchema>;

export const listOrdersInputSchema = listOrdersQuerySchema.extend({
  channel: z.enum(Channel).optional(),
  paymentStatus: z.enum(PaymentStatus).optional(),
  reference: plainText(32).pipe(z.string().min(1)).optional(),
});
export type ListOrdersInput = z.input<typeof listOrdersInputSchema>;

export const orderBoardInputSchema = z
  .object({
    statuses: z.array(z.enum(OrderStatus)).min(1).max(9).optional(),
    limitPerStatus: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type OrderBoardInput = z.input<typeof orderBoardInputSchema>;
