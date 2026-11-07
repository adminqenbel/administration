import { Body, Controller, Get, Inject, Put } from "@nestjs/common";
import { z } from "zod";
import { AppError, ErrorCode } from "@qenbel/shared";
import { Permission, CurrentPrincipal, ReqMeta, type RequestMeta, Tx } from "../authz/decorators.ts";
import { ApiPermission } from "../authz/permissions.ts";
import type { Principal } from "../auth/principal.ts";
import type { TenantTx } from "../common/request-state.ts";
import { AuditService, entryFor } from "../audit/audit.service.ts";
import { zodPipe } from "../errors/zod.pipe.ts";
import { isValidTimeZone, loadTenant, updateTenantProfile } from "./tenant-repo.ts";

/** Closed object: unknown keys (tenantId, role, packId...) are refused with VALIDATION_FAILED. */
export const updateProfileSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    defaultTimezone: z.string().trim().min(1).max(64).optional(),
  })
  .refine((v) => v.name !== undefined || v.defaultTimezone !== undefined, { message: "Send at least one field to change." })
  .refine((v) => v.defaultTimezone === undefined || isValidTimeZone(v.defaultTimezone), {
    path: ["defaultTimezone"],
    message: "Use an IANA time zone such as Asia/Kolkata.",
  });
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** Stub for Stage 3: the business profile as stored on the tenants row. */
@Controller("business/profile")
export class BusinessController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Permission(ApiPermission.BUSINESS_READ)
  @Get()
  async get(@Tx() tx: TenantTx) {
    return { profile: await loadTenant(tx.sql, tx.tenantId) };
  }

  @Permission(ApiPermission.BUSINESS_WRITE)
  @Put()
  async update(
    @Body(zodPipe(updateProfileSchema)) body: UpdateProfileInput,
    @Tx() tx: TenantTx,
    @CurrentPrincipal() principal: Principal,
    @ReqMeta() meta: RequestMeta,
  ) {
    if (body.name === undefined && body.defaultTimezone === undefined) throw new AppError(ErrorCode.VALIDATION_FAILED);
    const profile = await updateTenantProfile(tx.sql, tx.tenantId, body);
    await this.audit.record(
      tx.sql,
      entryFor(principal, meta, {
        action: "business.profile.update",
        entityType: "tenant",
        entityId: tx.tenantId,
        details: { fields: Object.keys(body) },
      }),
    );
    return { profile };
  }
}
