// Order DTOs. Prices are server-side: a client or AI tool never sends a unit price.
import { z } from "zod";
import { Channel, OrderStatus, PaymentStatus } from "../enums.ts";
import { idSchema, plainText, versionSchema } from "./common.ts";
import { createCustomerSchema } from "./customer.ts";
import { instantSchema } from "../time.ts";

export const orderStatusSchema = z.enum(OrderStatus);
export const paymentStatusSchema = z.enum(PaymentStatus);

/** Integer paise, never a float. */
export const paiseSchema = z.number().int().safe();
export const nonNegativePaiseSchema = paiseSchema.min(0);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const orderItemInputSchema = z
  .object({
    catalogueItemId: idSchema,
    quantity: z.number().int().min(1).max(999),
    note: plainText(200).optional(),
  })
  .strict();
export type OrderItemInput = z.infer<typeof orderItemInputSchema>;

const itemsSchema = z.array(orderItemInputSchema).min(1).max(100);

/** create_order_draft. */
export const createOrderDraftSchema = z
  .object({
    items: itemsSchema,
    customerId: idSchema.optional(),
    /** Table or other resource for dine-in orders. */
    resourceId: idSchema.optional(),
    bookingId: idSchema.optional(),
    notes: plainText(1000).optional(),
  })
  .strict();
export type CreateOrderDraft = z.infer<typeof createOrderDraftSchema>;

/** Only DRAFT orders can be edited. */
export const updateOrderDraftSchema = z
  .object({
    items: itemsSchema.optional(),
    notes: plainText(1000).nullable().optional(),
    expectedVersion: versionSchema,
  })
  .strict();
export type UpdateOrderDraft = z.infer<typeof updateOrderDraftSchema>;

/** confirm_order: moves DRAFT to PLACED. */
export const confirmOrderSchema = z
  .object({
    customerId: idSchema.optional(),
    customer: createCustomerSchema.optional(),
    expectedVersion: versionSchema.optional(),
  })
  .strict()
  .refine((v) => v.customerId === undefined || v.customer === undefined, {
    message: "Provide customerId or customer, not both",
    path: ["customerId"],
  });
export type ConfirmOrder = z.infer<typeof confirmOrderSchema>;

export const cancelOrderSchema = z
  .object({ reason: plainText(300).optional(), expectedVersion: versionSchema.optional() })
  .strict();
export type CancelOrder = z.infer<typeof cancelOrderSchema>;

/** Dashboard and kitchen actions. `to` is checked against the pack machine by the engine. */
export const transitionOrderSchema = z
  .object({ to: orderStatusSchema, reason: plainText(300).optional(), expectedVersion: versionSchema })
  .strict();
export type TransitionOrder = z.infer<typeof transitionOrderSchema>;

export const orderItemSchema = z.object({
  id: idSchema,
  catalogueItemId: idSchema.nullable(),
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPricePaise: nonNegativePaiseSchema,
  linePaise: nonNegativePaiseSchema,
  note: z.string().nullable(),
});
export type OrderItem = z.infer<typeof orderItemSchema>;

export const orderSchema = z.object({
  id: idSchema,
  status: orderStatusSchema,
  customerId: idSchema.nullable(),
  bookingId: idSchema.nullable(),
  resourceId: idSchema.nullable(),
  items: z.array(orderItemSchema),
  subtotalPaise: nonNegativePaiseSchema,
  discountPaise: nonNegativePaiseSchema,
  taxPaise: nonNegativePaiseSchema,
  totalPaise: nonNegativePaiseSchema,
  currency: currencySchema,
  paymentStatus: paymentStatusSchema,
  notes: z.string().nullable(),
  source: z.enum(Channel),
  version: versionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Order = z.infer<typeof orderSchema>;

export const listOrdersQuerySchema = z
  .object({
    status: orderStatusSchema.optional(),
    customerId: idSchema.optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
