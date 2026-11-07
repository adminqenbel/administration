import { z } from "zod";
import { packIds } from "@qenbel/config-packs";
import { AuthProviderKind } from "@qenbel/shared";
import { isValidTimeZone } from "../business/tenant-repo.ts";

const CLERK_SUBJECT = /^user_[A-Za-z0-9]+$/;
const DEV_SUBJECT = /^dev\|[A-Za-z0-9._-]{1,64}$/;

/** Body of POST /v1/platform/tenants. Closed object: nothing outside these fields is accepted. */
export function createTenantSchema(authProvider: AuthProviderKind) {
  const subject = authProvider === AuthProviderKind.DEV ? DEV_SUBJECT : CLERK_SUBJECT;
  return z.strictObject({
    name: z.string().trim().min(1).max(200),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use lowercase letters, digits and hyphens (2 to 63 characters)."),
    packId: z.enum(packIds),
    timezone: z
      .string()
      .trim()
      .max(64)
      .refine(isValidTimeZone, "Use an IANA time zone such as Asia/Kolkata.")
      .optional(),
    owner: z.strictObject({
      name: z.string().trim().min(1).max(200),
      email: z.email().max(254).optional(),
      externalSubject: z.string().regex(subject, authProvider === AuthProviderKind.DEV ? "Use dev|<name>." : "Use the Clerk user id (user_...)."),
    }),
  });
}

export type CreateTenantInput = z.infer<ReturnType<typeof createTenantSchema>>;
