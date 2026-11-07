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
/** Functions each role may execute (migration 017 onwards). Anything else executable is a failure. Extension members are ignored. */
export const FUNCTION_ALLOW_LIST = {
  PUBLIC: ["current_tenant_id()"],
  qenbel_app: [
    "current_principal()",
    "current_tenant_id()",
    "expire_booking_holds_for_current_tenant(timestamp with time zone)",
    "webhook_url_is_safe(text)",
  ],
  qenbel_auth: [
    "auth_is_platform_admin(text,text)",
    "auth_lookup_credential(text)",
    "auth_lookup_user(text,text)",
    "current_tenant_id()",
  ],
  qenbel_platform_ops: [
    "current_tenant_id()",
    "expire_booking_holds()",
    "platform_clear_tenant_proof_keys()",
    "platform_create_tenant(text,text,text,text,text,text,uuid)",
    "platform_create_tenant_with_owner(text,text,text,text,text,text,uuid,text,text,text,text,text,text,text,jsonb)",
    "platform_list_active_tenants()",
    "platform_set_tenant_proof_keys(bytea,bytea)",
    "platform_set_tenant_status(uuid,text)",
    "platform_tenant_proof_enabled()",
    "purge_expired_idempotency_keys()",
  ],
} as const;

export type GranteeName = keyof typeof FUNCTION_ALLOW_LIST;

/** Non-extension functions in schema public that `grantee` can execute (PUBLIC: granted to PUBLIC itself), sorted. */
export async function executableFunctions(db: Queryable, grantee: GranteeName): Promise<string[]> {
  const sql =
    grantee === "PUBLIC"
      ? `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
            and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`
      : `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
            and has_function_privilege($1, p.oid, 'EXECUTE')`;
  const res = await db.query<{ fn: string }>(sql, grantee === "PUBLIC" ? [] : [grantee]);
  return res.rows.map((r) => r.fn).sort();
}

export async function checkDatabase(
  appPool: Pool,
  migratePool: Pool,
  extra: { platformPool?: Pool; authPool?: Pool } = {},
): Promise<CheckResult[]> {
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

  // 6. function privileges (SEC-001/002), only once migration 017 is applied
  const has017 = recorded.has("017_privilege_split.sql");
  if (has017) {
    for (const grantee of Object.keys(FUNCTION_ALLOW_LIST) as GranteeName[]) {
      const allowed = new Set<string>(FUNCTION_ALLOW_LIST[grantee]);
      const extraFns = (await executableFunctions(migratePool, grantee)).filter((f) => !allowed.has(f));
      add(`${grantee} can execute only its allow-listed functions`, extraFns.length === 0, extraFns.join(", "));
    }
    const tablePriv = await migratePool.query<{ r: string; t: string }>(
      `select r.rolname as r, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (select rolname from pg_roles where rolname in ('qenbel_auth', 'qenbel_platform_ops')) r
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
          and has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`);
    add("qenbel_auth and qenbel_platform_ops have no table privileges", tablePriv.rowCount === 0,
      tablePriv.rows.map((x) => `${x.r}:${x.t}`).join(", "));
  }
  if (extra.authPool) {
    const a = await extra.authPool.query<{ user: string }>("select current_user as user");
    add("auth pool connects as qenbel_auth", a.rows[0]?.user === "qenbel_auth", a.rows[0]?.user);
  }
  if (extra.platformPool) {
    const p = await extra.platformPool.query<{ user: string }>("select current_user as user");
    add("platform pool connects as qenbel_platform_ops", p.rows[0]?.user === "qenbel_platform_ops", p.rows[0]?.user);
    if (recorded.has("021_tenant_proof.sql")) {
      const on = (await extra.platformPool.query<{ on: boolean }>("select platform_tenant_proof_enabled() as on")).rows[0]?.on === true;
      add(`tenant proof (SEC-003) is ${on ? "enabled" : "disabled; set it with db.ts tenant-proof enable"}`, true);
    }
  }

  return results;
}
