// Engine input schemas. All strict: an unknown key (tenantId, role, status ...) is VALIDATION_FAILED.
// Where @qenbel/shared already defines the request body it is reused unchanged; the engine adds `bookingId`
// (taken from the route or tool call, never from the body of a different booking).
import { z } from "zod";
import {
  AppError,
  BookingStatus,
  Channel,
  ErrorCode,
  idSchema,
  instantSchema,
  localDateSchema,
  parseOrThrow,
  plainText,
  validationError,
  versionSchema,
} from "@qenbel/shared";

const durationMinutes = z.number().int().min(1).max(1440);
const partySize = z.number().int().min(1).max(100);

/**
 * create_booking_hold plus `resourceIds` for a booking that needs several resources at once
 * (a party across two tables, a stylist and a room). Give resourceId, resourceIds or neither (the engine picks).
 */
export const createHoldInputSchema = z
  .object({
    startsAt: instantSchema,
    endsAt: instantSchema.optional(),
    durationMinutes: durationMinutes.optional(),
    resourceId: idSchema.optional(),
    resourceIds: z.array(idSchema).min(1).max(10).optional(),
    catalogueItemId: idSchema.optional(),
    customerId: idSchema.optional(),
    partySize: partySize.optional(),
    notes: plainText(1000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.endsAt !== undefined && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "endsAt must be after startsAt" });
    }
    if (v.endsAt !== undefined && v.durationMinutes !== undefined) {
      ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "Use endsAt or durationMinutes, not both" });
    }
    if (v.resourceId !== undefined && v.resourceIds !== undefined) {
      ctx.addIssue({ code: "custom", path: ["resourceIds"], message: "Use resourceId or resourceIds, not both" });
    }
    if (v.resourceIds !== undefined && new Set(v.resourceIds).size !== v.resourceIds.length) {
      ctx.addIssue({ code: "custom", path: ["resourceIds"], message: "Resources must not repeat" });
    }
    if (v.endsAt === undefined && v.durationMinutes === undefined && v.catalogueItemId === undefined) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "Provide endsAt, durationMinutes or catalogueItemId" });
    }
  });
export type CreateHoldInput = z.infer<typeof createHoldInputSchema>;

export const lifecycleInputSchema = z.object({ expectedVersion: versionSchema }).strict();

export const getBookingInputSchema = z.object({ bookingId: idSchema }).strict();

/** list_bookings filters (shared listBookingsQuerySchema) plus channel and a local date. */
export const listBookingsInputSchema = z
  .object({
    status: z.enum(BookingStatus).optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    /** One local day in the default location's zone. Not combined with from/to. */
    date: localDateSchema.optional(),
    resourceId: idSchema.optional(),
    customerId: idSchema.optional(),
    channel: z.enum(Channel).optional(),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.date !== undefined && (v.from !== undefined || v.to !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Use date or from/to, not both" });
    }
    if (v.from !== undefined && v.to !== undefined && Date.parse(v.to) <= Date.parse(v.from)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be after from" });
    }
  });
export type ListBookingsInput = z.infer<typeof listBookingsInputSchema>;

/** Split `{ bookingId, ...body }`. The body is then validated by the strict schema for the action. */
export function splitBookingId(raw: unknown): { bookingId: string; body: Record<string, unknown> } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, "The request is not valid.");
  }
  const { bookingId, ...body } = raw as Record<string, unknown>;
  const parsed = idSchema.safeParse(bookingId);
  if (!parsed.success) throw validationError(parsed.error);
  return { bookingId: parsed.data, body };
}

export { parseOrThrow };
