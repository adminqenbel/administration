// Ids, pagination and small shared field schemas.
import { z } from "zod";
import { instantSchema } from "../time.ts";

/**
 * Row id (uuid). Lenient on version bits so fixed seed ids are accepted.
 * Never use it for tenant_id on input: tenants come from the principal only.
 */
export const idSchema = z.guid();
export type Id = z.infer<typeof idSchema>;

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use letters, digits and _ . : - only");

/** Plain text. Escaped on output by the UI; never interpreted as markup. */
export function plainText(max: number) {
  return z.string().trim().max(max);
}

export const paginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null };

export const versionSchema = z.number().int().min(1);

export const timestampsSchema = z.object({
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
