// API credential lifecycle (tenant-scoped). The key is generated here, only its peppered hash is stored, and
// the key is returned exactly once, in the creation response. It is not part of any later response, any log
// line, or the audit trail.
import { Inject, Injectable } from "@nestjs/common";
import { getPack, isPackId } from "@qenbel/config-packs";
import { AppError, CredentialType, ErrorCode, type SqlClient, type ToolName } from "@qenbel/shared";
import { generateApiKey } from "../auth/api-key.ts";
import { CONFIG } from "../common/tokens.ts";
import type { AppConfig } from "../config/config.ts";
import { loadTenant } from "../business/tenant-repo.ts";

export interface CredentialSummary {
  id: string;
  name: string;
  /** Non-secret prefix of the key, so an owner can recognise which key is which. */
  lookupId: string;
  toolScopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface CredRow {
  id: string;
  name: string;
  lookup_id: string;
  tool_scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

const COLUMNS = "id, name, lookup_id, tool_scopes, expires_at, revoked_at, last_used_at, created_at";
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function summary(r: CredRow): CredentialSummary {
  return {
    id: r.id,
    name: r.name,
    lookupId: r.lookup_id,
    toolScopes: r.tool_scopes,
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class CredentialsService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async create(
    sql: SqlClient,
    tenantId: string,
    createdByUserId: string | null,
    input: { name: string; toolScopes: ToolName[]; expiresAt?: Date },
  ): Promise<{ credential: CredentialSummary; key: string }> {
    // A credential can be scoped only to tools the tenant's pack allows (the tenant switch and the pack are
    // checked again on every call by the gateway).
    const tenant = await loadTenant(sql, tenantId);
    const allowed = tenant.packId && isPackId(tenant.packId) ? new Set<string>(getPack(tenant.packId).aiTools) : new Set<string>();
    const outside = input.toolScopes.filter((t) => !allowed.has(t));
    if (outside.length > 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, "Some tools are not available for this business.", {
        issues: [{ path: "toolScopes", code: "invalid_value", message: "Choose only tools your business pack allows." }],
      });
    }
    const generated = generateApiKey(this.config.apiKeyPepper, this.config.apiKeyPepperVersion);
    const res = await sql.query<CredRow>(
      `insert into api_credentials (tenant_id, credential_type, name, lookup_id, secret_hash, pepper_version, tool_scopes, created_by_user_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning ${COLUMNS}`,
      [
        tenantId,
        CredentialType.API_KEY,
        input.name,
        generated.lookupId,
        generated.secretHash,
        generated.pepperVersion,
        input.toolScopes,
        createdByUserId,
        input.expiresAt ?? null,
      ],
    );
    return { credential: summary(res.rows[0] as CredRow), key: generated.key };
  }

  async list(sql: SqlClient): Promise<CredentialSummary[]> {
    const res = await sql.query<CredRow>(
      `select ${COLUMNS} from api_credentials where credential_type = 'api_key' order by created_at desc, id limit 200`,
    );
    return res.rows.map(summary);
  }

  /** Revokes one key. A key of another tenant is invisible under RLS, so it is "not found", not "forbidden". */
  async revoke(sql: SqlClient, id: string): Promise<CredentialSummary> {
    const res = await sql.query<CredRow>(
      `update api_credentials set revoked_at = coalesce(revoked_at, now())
        where id = $1 and credential_type = 'api_key'
    returning ${COLUMNS}`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new AppError(ErrorCode.NOT_FOUND);
    return summary(row);
  }
}
