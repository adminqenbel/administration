// check_availability query and response.
import { z } from "zod";
import { idSchema } from "./common.ts";
import { instantSchema, localDateSchema, daysBetween } from "../time.ts";

export const MAX_AVAILABILITY_DAYS = 14;

export const availabilityQuerySchema = z
  .object({
    /** First local date (location timezone). */
    from: localDateSchema,
    /** Last local date, inclusive. Defaults to `from`. */
    to: localDateSchema.optional(),
    catalogueItemId: idSchema.optional(),
    resourceId: idSchema.optional(),
    durationMinutes: z.coerce.number().int().min(1).max(1440).optional(),
    partySize: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const to = v.to ?? v.from;
    if (!localDateSchema.safeParse(v.from).success || !localDateSchema.safeParse(to).success) return;
    const span = daysBetween(v.from, to);
    if (span < 0) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must not be before from" });
    } else if (span + 1 > MAX_AVAILABILITY_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Range is at most ${MAX_AVAILABILITY_DAYS} days` });
    }
  });
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const availabilitySlotSchema = z.object({
  startsAt: instantSchema,
  endsAt: instantSchema,
  resourceId: idSchema,
  resourceName: z.string(),
});
export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

export const availabilityResponseSchema = z.object({
  /** IANA timezone the dates in the query were read in. */
  timezone: z.string(),
  slots: z.array(availabilitySlotSchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
