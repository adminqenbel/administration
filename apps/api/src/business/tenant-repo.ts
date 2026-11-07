// Reads and writes of the caller's own tenants row. The runtime role can see and update only its own row
// (RLS on tenants, id = current_tenant_id()) and only the columns granted in migration 011.
import { AppError, ErrorCode, type SqlClient } from "@qenbel/shared";

export interface TenantProfile {
  id: string;
  slug: string;
  name: string;
  status: string;
  deploymentMode: string;
  packId: string | null;
  packVersion: string | null;
  defaultTimezone: string;
  updatedAt: string;
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  deployment_mode: string;
  pack_id: string | null;
  pack_version: string | null;
  default_timezone: string;
  updated_at: Date;
}

const COLUMNS = "id, slug, name, status, deployment_mode, pack_id, pack_version, default_timezone, updated_at";

function toProfile(r: TenantRow): TenantProfile {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    deploymentMode: r.deployment_mode,
    packId: r.pack_id,
    packVersion: r.pack_version,
    defaultTimezone: r.default_timezone,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function loadTenant(sql: SqlClient, tenantId: string): Promise<TenantProfile> {
  const res = await sql.query<TenantRow>(`select ${COLUMNS} from tenants where id = $1`, [tenantId]);
  const row = res.rows[0];
  if (!row) throw new AppError(ErrorCode.NOT_FOUND);
  return toProfile(row);
}

export async function updateTenantProfile(
  sql: SqlClient,
  tenantId: string,
  changes: { name?: string; defaultTimezone?: string },
): Promise<TenantProfile> {
  const res = await sql.query<TenantRow>(
    `update tenants
        set name = coalesce($2, name), default_timezone = coalesce($3, default_timezone)
      where id = $1
  returning ${COLUMNS}`,
    [tenantId, changes.name ?? null, changes.defaultTimezone ?? null],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(ErrorCode.NOT_FOUND);
  return toProfile(row);
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: value });
    return value.length <= 64;
  } catch {
    return false;
  }
}
