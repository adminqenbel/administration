// Customer DTOs. Input schemas are strict: unknown keys (such as tenantId) are rejected.
import { z } from "zod";
import { idSchema, plainText } from "./common.ts";
import { instantSchema, localDateSchema } from "../time.ts";

export const CustomerField = {
  NAME: "name",
  PHONE: "phone",
  EMAIL: "email",
  DATE_OF_BIRTH: "dateOfBirth",
  ADDRESS: "address",
} as const;
export type CustomerField = (typeof CustomerField)[keyof typeof CustomerField];
export const customerFieldSchema = z.enum(CustomerField);

/** Digits with an optional leading +, 8 to 15 digits. Spaces, dashes and brackets are stripped. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s\-().]/g, ""))
  .pipe(z.string().regex(/^\+?[1-9]\d{7,14}$/, "Enter a phone number with country code or 10 digits"));

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

const customerFields = {
  name: plainText(120).pipe(z.string().min(1)),
  phone: phoneSchema,
  email: emailSchema,
  dateOfBirth: localDateSchema,
  address: plainText(300),
  notes: plainText(1000),
};

export const createCustomerSchema = z
  .object({
    name: customerFields.name,
    phone: customerFields.phone.optional(),
    email: customerFields.email.optional(),
    dateOfBirth: customerFields.dateOfBirth.optional(),
    address: customerFields.address.optional(),
    notes: customerFields.notes.optional(),
  })
  .strict();
export type CreateCustomer = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    name: customerFields.name.optional(),
    phone: customerFields.phone.nullable().optional(),
    email: customerFields.email.nullable().optional(),
    dateOfBirth: customerFields.dateOfBirth.nullable().optional(),
    address: customerFields.address.nullable().optional(),
    notes: customerFields.notes.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field");
export type UpdateCustomer = z.infer<typeof updateCustomerSchema>;

export const customerSchema = z.object({
  id: idSchema,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  dateOfBirth: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  archivedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Customer = z.infer<typeof customerSchema>;

/** Minimal fields returned to AI tools by search_customer. */
export const customerSummarySchema = z.object({
  id: idSchema,
  name: z.string(),
  phone: z.string().nullable(),
});
export type CustomerSummary = z.infer<typeof customerSummarySchema>;

export const searchCustomerQuerySchema = z
  .object({ query: z.string().trim().min(2).max(120) })
  .strict();

/**
 * Names of required customer fields that are missing or empty in `customer`.
 * Used by confirm_booking against the pack's requiredCustomerFields.
 */
export function missingCustomerFields(
  required: readonly CustomerField[],
  customer: Partial<Record<CustomerField, unknown>>,
): CustomerField[] {
  return required.filter((f) => {
    const v = customer[f];
    return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
  });
}
