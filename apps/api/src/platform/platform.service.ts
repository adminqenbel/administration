// Platform-level tenant creation. Authorisation (PLATFORM_ADMIN) is enforced by the access guard before
// this runs: the database function cannot check it. Everything happens in ONE transaction under the new
// tenant's id, so either the tenant, its owner and the audit row all exist, or none of them do:
//   platform_create_tenant(...)  -> SECURITY DEFINER, inserts the tenants row
//   insert into users            -> under RLS (app.tenant_id = the new tenant), the first OWNER
//   insert into audit_log        -> under RLS
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { getPack } from "@qenbel/config-packs";
import { withTenant, type Pool } from "@qenbel/db";
import { AppError, AuditOutcome, DeploymentMode, ErrorCode, PrincipalKind, UserRole, type SqlClient } from "@qenbel/shared";
import { AuditService } from "../audit/audit.service.ts";
import type { Principal } from "../auth/principal.ts";
import { principalId } from "../auth/principal.ts";
import { CONFIG, DB_POOL } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";
import { isPgError } from "../errors/pg-errors.ts";
import { loadTenant, type TenantProfile } from "../business/tenant-repo.ts";
import type { CreateTenantInput } from "./platform.schemas.ts";

export interface CreatedTenant {
  tenant: TenantProfile;
  owner: { id: string; role: typeof UserRole.OWNER; name: string; email: string | null };
}

@Injectable()
export class PlatformService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createTenant(admin: Principal, input: CreateTenantInput, meta: { requestId: string; ip: string | null }): Promise<CreatedTenant> {
    const pack = getPack(input.packId); // NOT_FOUND for an unknown pack, VALIDATION happens in the schema
    const isolated = this.config.deploymentMode === DeploymentMode.ISOLATED;
    // Isolated deployments have exactly one tenant, whose id comes from configuration.
    const tenantId = isolated ? (this.config.isolatedTenantId as string) : randomUUID();
    const mode = isolated ? DeploymentMode.ISOLATED : DeploymentMode.CENTRAL;

    try {
      return await withTenant(this.pool, tenantId, async (client) => {
        const sql = client as unknown as SqlClient;
        await sql.query("select platform_create_tenant($1, $2, $3, $4, $5, $6, $7)", [
          input.slug,
          input.name,
          mode,
          pack.id,
          pack.version,
          input.timezone ?? "Asia/Kolkata",
          tenantId,
        ]);
        const owner = await sql.query<{ id: string }>(
          `insert into users (tenant_id, auth_provider, external_subject, email, name, role)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [tenantId, this.config.authProvider, input.owner.externalSubject, input.owner.email ?? null, input.owner.name, UserRole.OWNER],
        );
        const ownerId = (owner.rows[0] as { id: string }).id;
        await this.audit.record(sql, {
          tenantId,
          actorKind: PrincipalKind.PLATFORM_ADMIN,
          actorId: principalId(admin),
          action: "platform.tenant.create",
          outcome: AuditOutcome.SUCCESS,
          entityType: "tenant",
          entityId: tenantId,
          channel: admin.channel,
          requestId: meta.requestId,
          ip: meta.ip,
          details: { slug: input.slug, packId: pack.id, packVersion: pack.version, deploymentMode: mode },
        });
        return {
          tenant: await loadTenant(sql, tenantId),
          owner: { id: ownerId, role: UserRole.OWNER, name: input.owner.name, email: input.owner.email ?? null },
        };
      });
    } catch (err) {
      if (isPgError(err) && err.code === "23505") {
        if (err.constraint === "tenants_slug_key") {
          throw new AppError(ErrorCode.CONFLICT, "That slug is already used.", { field: "slug" });
        }
        if (err.constraint === "tenants_single_isolated" || err.constraint === "tenants_pkey") {
          throw new AppError(ErrorCode.CONFLICT, "This deployment already has its business.");
        }
      }
      throw err;
    }
  }
}
