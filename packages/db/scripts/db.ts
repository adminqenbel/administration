// Usage: node scripts/db.ts <migrate | seed [--reset] | check> [--test]
//   migrate        apply pending SQL migrations (as qenbel_migrate)
//   seed           insert fake demo data for two tenants (as qenbel_app); skips tenants already seeded
//   seed --reset   truncate all tenant data first (local database only), then seed
//   check          verify roles, migrations and RLS; exits 1 on any failure
//   tenant-proof <status|enable|disable>   SEC-003 signed tenant context (migration 021); enable reads QENBEL_TENANT_PROOF_KEY
//                  (hex, >= 32 bytes) and optional QENBEL_TENANT_PROOF_KEY_PREVIOUS; runs as qenbel_platform_ops
//   --test         operate on the test database (qenbel_admin_test) instead of the dev database
import {
  checkDatabase, createPool, parseTenantProofKey, requireLeastPrivilegeUrls, resolveDatabaseUrls, runMigrations, seed, DEV_DATABASE, TEST_DATABASE,
} from "../src/index.ts";

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--"));
const flags = new Set(args.filter((a) => a.startsWith("--")));
const database = flags.has("--test") ? TEST_DATABASE : DEV_DATABASE;

function usage(): never {
  process.stderr.write("Usage: db.ts <migrate | seed [--reset] | check> [--test]\n");
  process.exit(2);
}

async function main(): Promise<number> {
  if (!command || !["migrate", "seed", "check", "tenant-proof"].includes(command)) usage();
  const urls = resolveDatabaseUrls(database);
  const migratePool = createPool({ connectionString: urls.migrateUrl, max: 2, applicationName: "qenbel-db-script-migrate" });
  const appPool = createPool({ connectionString: urls.appUrl, max: 2, applicationName: "qenbel-db-script-app" });
  const lp = command === "migrate" ? null : requireLeastPrivilegeUrls(urls);
  const platformPool = lp ? createPool({ connectionString: lp.platformUrl, max: 2, applicationName: "qenbel-db-script-platform" }) : null;
  const authPool = lp ? createPool({ connectionString: lp.authUrl, max: 1, applicationName: "qenbel-db-script-auth" }) : null;
  const log = (line: string) => process.stdout.write(`${line}\n`);
  try {
    if (command === "migrate") {
      const res = await runMigrations(migratePool, { log });
      log(`migrations: ${res.applied.length} applied, ${res.alreadyApplied.length} already applied (${database})`);
      return 0;
    }
    if (command === "seed") {
      const res = await seed({ appPool, platformPool: platformPool as NonNullable<typeof platformPool>, migratePool, reset: flags.has("--reset"), migrateUrl: urls.migrateUrl, log });
      log(`seed done: ${res.tenants.map((t) => `${t.slug}=${t.created ? "created" : "kept"}`).join(", ")} (${database})`);
      return 0;
    }
    if (command === "tenant-proof") {
      const sub = args.filter((a) => !a.startsWith("--"))[1] ?? "status";
      const ops = platformPool as NonNullable<typeof platformPool>;
      if (sub === "enable") {
        const cur = process.env.QENBEL_TENANT_PROOF_KEY;
        if (!cur) throw new Error("QENBEL_TENANT_PROOF_KEY is not set");
        const prev = process.env.QENBEL_TENANT_PROOF_KEY_PREVIOUS;
        await ops.query("select platform_set_tenant_proof_keys($1, $2)", [parseTenantProofKey(cur), prev ? parseTenantProofKey(prev) : null]);
      } else if (sub === "disable") {
        await ops.query("select platform_clear_tenant_proof_keys()");
      } else if (sub !== "status") {
        usage();
      }
      const on = (await ops.query<{ on: boolean }>("select platform_tenant_proof_enabled() as on")).rows[0]?.on === true;
      log(`tenant proof: ${on ? "enabled" : "disabled"} (${database})`);
      return 0;
    }
    const results = await checkDatabase(appPool, migratePool, { platformPool: platformPool ?? undefined, authPool: authPool ?? undefined });
    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed++;
      log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    }
    log(failed === 0 ? `all ${results.length} checks passed (${database})` : `${failed} of ${results.length} checks failed (${database})`);
    return failed === 0 ? 0 : 1;
  } finally {
    await Promise.allSettled([appPool.end(), migratePool.end(), platformPool?.end(), authPool?.end()]);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Print the message only. Connection errors may echo host and user but never the password.
    process.stderr.write(`db: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
