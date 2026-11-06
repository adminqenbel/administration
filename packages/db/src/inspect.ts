import { loadMigrations } from "./migrate.ts";
import type { Pool, PoolClient } from "./pool.ts";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface TenantTableInfo {
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  /** Names of policies on the table whose expression uses current_tenant_id(). */
  tenantPolicies: string[];
}

/** Every base table in `public` that carries a tenant_id column, plus `tenants` itself (its own row is tenant-scoped). */
export async function listTenantTables(db: Queryable): Promise<TenantTableInfo[]> {
  const res = await db.query<{ table: string; enabled: boolean; forced: boolean; policies: string[] | null }>(`
    select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           (select array_agg(p.polname order by p.polname)
              from pg_policy p
             where p.polrelid = c.oid
               and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%current_tenant_id()%')
               and (p.polwithcheck is null or pg_get_expr(p.polwithcheck, p.polrelid) like '%current_tenant_id()%')) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (c.relname = 'tenants'
            or exists (select 1 from pg_attribute a
                        where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))
     order by c.relname`);
  return res.rows.map((r) => ({
    table: r.table,
    rlsEnabled: r.enabled,
    rlsForced: r.forced,
    tenantPolicies: r.policies ?? [],
  }));
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * Read-only health and safety check. `appPool` connects as qenbel_app, `migratePool` as qenbel_migrate.
 * Used by `db.ts check` and by tests.
 */
export async function checkDatabase(appPool: Pool, migratePool: Pool): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail?: string) => results.push(detail === undefined ? { name, ok } : { name, ok, detail });

  // 1. roles
  const me = await appPool.query<{ user: string; super: boolean; bypass: boolean }>(
    "select current_user as user, r.rolsuper as super, r.rolbypassrls as bypass from pg_roles r where r.rolname = current_user");
  const who = me.rows[0];
  add("app role is qenbel_app", who?.user === "qenbel_app", who?.user);
  add("app role is not superuser and has no BYPASSRLS", who !== undefined && !who.super && !who.bypass);
  const owned = await appPool.query<{ n: string }>(
    "select count(*)::text as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relowner = (select oid from pg_roles where rolname = current_user)");
  add("app role owns no tables", owned.rows[0]?.n === "0", `owns ${owned.rows[0]?.n}`);

  // 2. migrations
  const files = await loadMigrations();
  let recorded: Map<string, string>;
  try {
    const rows = (await migratePool.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows;
    recorded = new Map(rows.map((r) => [r.name, r.checksum]));
  } catch (err) {
    add("migrations table readable", false, (err as Error).message);
    return results;
  }
  const pending = files.filter((f) => !recorded.has(f.name)).map((f) => f.name);
  const changed = files.filter((f) => recorded.has(f.name) && recorded.get(f.name) !== f.checksum).map((f) => f.name);
  add("no pending migrations", pending.length === 0, pending.join(", "));
  add("applied migrations unchanged", changed.length === 0, changed.join(", "));

  // 3. RLS on every tenant table
  const tables = await listTenantTables(migratePool);
  const missing = tables.filter((t) => !t.rlsEnabled || !t.rlsForced || t.tenantPolicies.length === 0).map((t) => t.table);
  add(`RLS enabled, forced and policed on all ${tables.length} tenant tables`, missing.length === 0, missing.join(", "));

  // 4. behaviour: no tenant => no rows
  const none = await appPool.query<{ n: string }>("select count(*)::text as n from locations");
  add("no tenant context sees zero rows", none.rows[0]?.n === "0", `saw ${none.rows[0]?.n}`);

  // 5. audit log privileges
  const priv = await appPool.query<{ upd: boolean; del: boolean; ins: boolean }>(
    "select has_table_privilege('audit_log', 'UPDATE') as upd, has_table_privilege('audit_log', 'DELETE') as del, has_table_privilege('audit_log', 'INSERT') as ins");
  add("audit_log is insert-only for the app role", priv.rows[0]?.ins === true && priv.rows[0]?.upd === false && priv.rows[0]?.del === false);

  return results;
}
