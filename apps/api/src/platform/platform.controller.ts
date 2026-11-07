import { Body, Controller, Inject, Post } from "@nestjs/common";
import { CONFIG } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";
import { CurrentPrincipal, PlatformAdmin, ReqMeta, type RequestMeta } from "../authz/decorators.ts";
import type { Principal } from "../auth/principal.ts";
import { ZodPipe } from "../errors/zod.pipe.ts";
import { PlatformService } from "./platform.service.ts";
import { type CreateTenantInput, createTenantSchema } from "./platform.schemas.ts";

@Controller("platform/tenants")
export class PlatformController {
  private readonly bodyPipe: ZodPipe<ReturnType<typeof createTenantSchema>>;

  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    this.bodyPipe = new ZodPipe(createTenantSchema(config.authProvider));
  }

  /**
   * Creates a business, picks its pack and makes the named person its OWNER. PLATFORM_ADMIN only.
   * Not @Idempotent(): there is no tenant yet to scope a key to; the unique slug makes a repeat a 409.
   */
  @PlatformAdmin()
  @Post()
  async create(@Body() raw: unknown, @CurrentPrincipal() admin: Principal, @ReqMeta() meta: RequestMeta) {
    const body: CreateTenantInput = this.bodyPipe.transform(raw);
    return this.platform.createTenant(admin, body, meta);
  }
}
