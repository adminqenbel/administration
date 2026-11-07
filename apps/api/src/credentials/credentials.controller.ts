import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { ToolName, idSchema } from "@qenbel/shared";
import { CurrentPrincipal, Permission, ReqMeta, type RequestMeta, Tx } from "../authz/decorators.ts";
import { ApiPermission } from "../authz/permissions.ts";
import type { Principal } from "../auth/principal.ts";
import type { TenantTx } from "../common/request-state.ts";
import { AuditService, entryFor } from "../audit/audit.service.ts";
import { zodPipe } from "../errors/zod.pipe.ts";
import { CredentialsService } from "./credentials.service.ts";

export const createCredentialSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  toolScopes: z.array(z.enum(ToolName)).min(1).max(13),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;

const idParam = zodPipe(idSchema);

@Controller("integrations/api-credentials")
export class CredentialsController {
  constructor(
    @Inject(CredentialsService) private readonly credentials: CredentialsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Permission(ApiPermission.INTEGRATIONS_READ)
  @Get()
  async list(@Tx() tx: TenantTx) {
    return { data: await this.credentials.list(tx.sql) };
  }

  /**
   * Returns the key once. Not @Idempotent(): replaying a stored response would keep the plaintext key in the
   * idempotency table, which is exactly what "shown once" rules out. (Recorded in CONTRACT-REQUESTS.md.)
   */
  @Permission(ApiPermission.INTEGRATIONS_MANAGE)
  @Post()
  @Header("Cache-Control", "no-store")
  async create(
    @Body(zodPipe(createCredentialSchema)) body: CreateCredentialInput,
    @Tx() tx: TenantTx,
    @CurrentPrincipal() principal: Principal,
    @ReqMeta() meta: RequestMeta,
  ) {
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
    const { credential, key } = await this.credentials.create(tx.sql, tx.tenantId, principal.userId, {
      name: body.name,
      toolScopes: body.toolScopes,
      expiresAt,
    });
    await this.audit.record(
      tx.sql,
      entryFor(principal, meta, {
        action: "integrations.api_credential.create",
        entityType: "api_credential",
        entityId: credential.id,
        details: { name: credential.name, toolScopes: credential.toolScopes },
      }),
    );
    return { credential, key, note: "Copy this key now. It is not shown again." };
  }

  @Permission(ApiPermission.INTEGRATIONS_MANAGE)
  @Post(":credentialId/revoke")
  @HttpCode(200)
  async revoke(
    @Param("credentialId", idParam) credentialId: string,
    @Tx() tx: TenantTx,
    @CurrentPrincipal() principal: Principal,
    @ReqMeta() meta: RequestMeta,
  ) {
    const credential = await this.credentials.revoke(tx.sql, credentialId);
    await this.audit.record(
      tx.sql,
      entryFor(principal, meta, {
        action: "integrations.api_credential.revoke",
        entityType: "api_credential",
        entityId: credential.id,
      }),
    );
    return { credential };
  }
}
