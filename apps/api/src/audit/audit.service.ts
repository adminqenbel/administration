// Audit trail writer. The table is append-only (the database rejects UPDATE and DELETE for every role).
// `record` writes inside the caller's tenant transaction, so a sensitive change and its audit row commit
// or roll back together. `recordSeparately` uses its own short transaction and is for denials and failures,
// which must be kept even though the request's transaction is rolled back.
import { Inject, Injectable } from "@nestjs/common";
import { AuditOutcome, type Channel, type PrincipalKind, type SqlClient } from "@qenbel/shared";
import { withTenant, type Pool } from "@qenbel/db";
import { DB_POOL, LOGGER } from "../common/tokens.ts";
import { AppLogger, errorFields, redact } from "../common/logger.ts";
import type { Principal } from "../auth/principal.ts";
import { principalId } from "../auth/principal.ts";

export interface AuditEntry {
  tenantId: string;
  actorKind: PrincipalKind;
  actorId: string | null;
  /** for example "business.profile.update" */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome?: AuditOutcome;
  channel?: Channel | null;
  requestId?: string | null;
  ip?: string | null;
  /** Never put secrets or personal data here. Keys that look secret are redacted anyway. */
  details?: Record<string, unknown>;
}

const MAX_DETAILS_CHARS = 4000;

export function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const clean = (redact(details ?? {}) ?? {}) as Record<string, unknown>;
  const json = JSON.stringify(clean);
  if (json.length > MAX_DETAILS_CHARS) return { truncated: true };
  return clean;
}

/** Audit entry fields that come from the principal and the request. */
export function entryFor(
  principal: Principal,
  meta: { requestId: string; ip: string | null },
  entry: Pick<AuditEntry, "action"> & Partial<AuditEntry>,
): AuditEntry {
  if (!principal.tenantId && !entry.tenantId) throw new Error("audit entry needs a tenant");
  return {
    tenantId: (entry.tenantId ?? principal.tenantId) as string,
    actorKind: principal.kind,
    actorId: principalId(principal),
    channel: principal.channel,
    requestId: meta.requestId,
    ip: meta.ip,
    ...entry,
  };
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(LOGGER) private readonly logger: AppLogger,
  ) {}

  async record(sql: SqlClient, e: AuditEntry): Promise<void> {
    await sql.query(
      `insert into audit_log (tenant_id, actor_kind, actor_id, action, entity_type, entity_id, outcome, channel, request_id, ip_address, details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        e.tenantId,
        e.actorKind,
        e.actorId,
        e.action,
        e.entityType ?? null,
        e.entityId ?? null,
        e.outcome ?? AuditOutcome.SUCCESS,
        e.channel ?? null,
        e.requestId ?? null,
        e.ip ?? null,
        JSON.stringify(sanitizeDetails(e.details)),
      ],
    );
  }

  /**
   * Own transaction. Never throws: a failure to audit a denial must not turn the denial into a 500 or hide it,
   * so it is logged and the caller carries on.
   */
  async recordSeparately(e: AuditEntry): Promise<boolean> {
    try {
      await withTenant(this.pool, e.tenantId, (client) => this.record(client as unknown as SqlClient, e));
      return true;
    } catch (err) {
      this.logger.error("audit write failed", { action: e.action, outcome: e.outcome, err: errorFields(err) });
      return false;
    }
  }
}
