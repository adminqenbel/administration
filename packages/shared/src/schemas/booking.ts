// Booking DTOs. Status changes go through dedicated actions, never a free-form status field on update.
import { z } from "zod";
import { BookingStatus, Channel } from "../enums.ts";
import { idSchema, plainText, versionSchema } from "./common.ts";
import { createCustomerSchema } from "./customer.ts";
import { instantSchema } from "../time.ts";

export const bookingStatusSchema = z.enum(BookingStatus);

const durationMinutes = z.number().int().min(1).max(1440);
const partySize = z.number().int().min(1).max(100);

const timeRangeInput = {
  startsAt: instantSchema,
  endsAt: instantSchema.optional(),
  durationMinutes: durationMinutes.optional(),
};

function rangeChecks<T extends { startsAt: string; endsAt?: string | undefined }>(v: T, ctx: z.RefinementCtx) {
  if (v.endsAt !== undefined && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
    ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
  }
}

/** create_booking_hold. Needs endsAt or durationMinutes or a catalogue item that defines the duration. */
export const createBookingHoldSchema = z
  .object({
    ...timeRangeInput,
    resourceId: idSchema.optional(),
    catalogueItemId: idSchema.optional(),
    customerId: idSchema.optional(),
    partySize: partySize.optional(),
    notes: plainText(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    rangeChecks(v, ctx);
    if (v.endsAt !== undefined && v.durationMinutes !== undefined) {
      ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "Use endsAt or durationMinutes, not both" });
    }
    if (v.endsAt === undefined && v.durationMinutes === undefined && v.catalogueItemId === undefined) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Provide endsAt, durationMinutes or catalogueItemId" });
    }
  });
export type CreateBookingHold = z.infer<typeof createBookingHoldSchema>;

/** confirm_booking: an existing customer id or new customer details, exactly one. */
export const confirmBookingSchema = z
  .object({
    customerId: idSchema.optional(),
    customer: createCustomerSchema.optional(),
    notes: plainText(1000).optional(),
    expectedVersion: versionSchema.optional(),
  })
  .strict()
  .refine((v) => (v.customerId === undefined) !== (v.customer === undefined), {
    message: "Provide customerId or customer, not both",
    path: ["customerId"],
  });
export type ConfirmBooking = z.infer<typeof confirmBookingSchema>;

export const rescheduleBookingSchema = z
  .object({
    ...timeRangeInput,
    resourceId: idSchema.optional(),
    expectedVersion: versionSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    rangeChecks(v, ctx);
    if (v.endsAt !== undefined && v.durationMinutes !== undefined) {
      ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "Use endsAt or durationMinutes, not both" });
    }
  });
export type RescheduleBooking = z.infer<typeof rescheduleBookingSchema>;

export const cancelBookingSchema = z
  .object({ reason: plainText(300).optional(), expectedVersion: versionSchema.optional() })
  .strict();
export type CancelBooking = z.infer<typeof cancelBookingSchema>;

/** Dashboard actions that move a booking forward or close it. */
export const BookingAction = {
  CHECK_IN: "CHECKED_IN",
  COMPLETE: "COMPLETED",
  NO_SHOW: "NO_SHOW",
} as const;
export const transitionBookingSchema = z
  .object({ to: z.enum(BookingAction), expectedVersion: versionSchema })
  .strict();
export type TransitionBooking = z.infer<typeof transitionBookingSchema>;

export const updateBookingSchema = z
  .object({ notes: plainText(1000).nullable().optional(), partySize: partySize.optional(), expectedVersion: versionSchema })
  .strict();
export type UpdateBooking = z.infer<typeof updateBookingSchema>;

export const bookingSchema = z.object({
  id: idSchema,
  status: bookingStatusSchema,
  resourceId: idSchema.nullable(),
  customerId: idSchema.nullable(),
  catalogueItemId: idSchema.nullable(),
  startsAt: instantSchema,
  endsAt: instantSchema,
  partySize: z.number().int().nullable(),
  notes: z.string().nullable(),
  holdExpiresAt: instantSchema.nullable(),
  source: z.enum(Channel),
  version: versionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Booking = z.infer<typeof bookingSchema>;

export const listBookingsQuerySchema = z
  .object({
    status: bookingStatusSchema.optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    resourceId: idSchema.optional(),
    customerId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type ListBookingsQuery = z.infer<typeof listBookingsQuerySchema>;
