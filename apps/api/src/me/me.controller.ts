import { Controller, Get, Inject } from "@nestjs/common";
import { getPack, isPackId } from "@qenbel/config-packs";
import { AllowApiCredential, Authenticated, CurrentPrincipal, OptionalTx } from "../authz/decorators.ts";
import type { Principal } from "../auth/principal.ts";
import type { TenantTx } from "../common/request-state.ts";
import { CONFIG } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";
import { loadTenant } from "../business/tenant-repo.ts";

@Controller("me")
export class MeController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  /** Who am I: the principal, the business and the pack words. Any signed-in principal may call it. */
  @Authenticated()
  @AllowApiCredential()
  @Get()
  async me(@CurrentPrincipal() principal: Principal, @OptionalTx() tx: TenantTx | undefined) {
    const tenant = tx ? await loadTenant(tx.sql, tx.tenantId) : null;
    const pack = tenant?.packId && isPackId(tenant.packId) ? getPack(tenant.packId) : null;
    return {
      principal: {
        kind: principal.kind,
        userId: principal.userId,
        credentialId: principal.credentialId,
        displayName: principal.displayName,
        role: principal.role,
        permissions: principal.permissions,
        allowedTools: principal.allowedTools,
        channel: principal.channel,
        isPlatformAdmin: principal.isPlatformAdmin,
      },
      tenant: tenant
        ? {
            id: tenant.id,
            slug: tenant.slug,
            name: tenant.name,
            status: tenant.status,
            packId: tenant.packId,
            packVersion: tenant.packVersion,
            defaultTimezone: tenant.defaultTimezone,
          }
        : null,
      pack: pack
        ? {
            id: pack.id,
            version: pack.version,
            label: pack.label,
            terminology: pack.terminology,
            bookingMode: pack.bookingMode,
            orderMode: pack.orderMode,
          }
        : null,
      deploymentMode: this.config.deploymentMode,
    };
  }
}
