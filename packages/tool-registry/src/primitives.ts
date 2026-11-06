import { z } from "zod";

// Every string, array and number that comes from a caller is bounded. The tests walk the
// generated JSON Schema and fail on any unbounded string or array.

/** Plain text with a hard length cap. Trimmed, no control characters. */
export const text = (min: number, max: number, what?: string) => {
  const s = z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), "Control characters are not allowed.");
  return what ? s.describe(what) : s;
};

export const idOf = (what: string) => z.uuid().max(36).describe(`Id of the ${what}, as returned by an earlier tool call.`);

export const isoDate = (what: string) =>
  z.iso.date().max(10).describe(`${what}, as YYYY-MM-DD in the business's local time zone.`);

export const isoDateTime = (what: string) =>
  z.iso.datetime({ offset: true }).max(40).describe(`${what}, ISO 8601 with a UTC offset, e.g. 2026-12-01T10:30:00+05:30.`);

export const phone = z
  .string()
  .max(16)
  .regex(/^\+[1-9][0-9]{6,14}$/, "Use international format, e.g. +919876543210.")
  .describe("Phone number in international format, e.g. +919876543210.");

export const email = z.email().max(254).describe("Email address.");

export const smallInt = (min: number, max: number, what: string) => z.int().min(min).max(max).describe(what);

/** Money is integer paise. Output only. */
export const paise = (what: string) => z.int().min(0).describe(`${what}, in paise (1 rupee = 100 paise).`);

export const currency = z.string().length(3).describe("ISO 4217 currency code, e.g. INR.");

/** Customer contact details a caller may pass. Which ones are required comes from the business's config pack. */
export const customerDetails = z.strictObject({
  name: text(1, 120, "Customer's name."),
  phone: phone.optional(),
  email: email.optional(),
});

/** Free-form answers to the business's own booking or order questions. Bounded list of name/value pairs. */
export const answers = z
  .array(
    z.strictObject({
      field: text(1, 60, "Field name exactly as listed in the business profile."),
      value: text(0, 300, "The customer's answer."),
    }),
  )
  .max(20)
  .describe("Answers to the extra questions this business asks. Only fields listed in the business profile.");
