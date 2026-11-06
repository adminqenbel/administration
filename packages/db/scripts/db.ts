// Usage: node scripts/db.ts <migrate | seed [--reset] | check> [--test]
//   migrate        apply pending SQL migrations (as qenbel_migrate)
//   seed           insert fake demo data for two tenants (as qenbel_app); skips tenants already seeded
//   seed --reset   truncate all tenant data first (local database only), then seed
//   check          verify roles, migrations and RLS; exits 1 on any failure
//   --test         operate on the test database (qenbel_admin_test) instead of the dev database
import {
  checkDatabase, createPool, resolveDatabaseUrls, runMigrations, seed, DEV_DATABASE, TEST_DATABASE,
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
  if (!command || !["migrate", "seed", "check"].includes(command)) usage();
  const urls = resolveDatabaseUrls(database);
  const migratePool = createPool({ connectionString: urls.migrateUrl, max: 2, applicationName: "qenbel-db-script-migrate" });
  const appPool = createPool({ connectionString: urls.appUrl, max: 2, applicationName: "qenbel-db-script-app" });
  const log = (line: string) => process.stdout.write(`${line}\n`);
  try {
    if (command === "migrate") {
      const res = await runMigrations(migratePool, { log });
      log(`migrations: ${res.applied.length} applied, ${res.alreadyApplied.length} already applied (${database})`);
      return 0;
    }
    if (command === "seed") {
      const res = await seed({ appPool, migratePool, reset: flags.has("--reset"), migrateUrl: urls.migrateUrl, log });
      log(`seed done: ${res.tenants.map((t) => `${t.slug}=${t.created ? "created" : "kept"}`).join(", ")} (${database})`);
      return 0;
    }
    const results = await checkDatabase(appPool, migratePool);
    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed++;
      log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    }
    log(failed === 0 ? `all ${results.length} checks passed (${database})` : `${failed} of ${results.length} checks failed (${database})`);
    return failed === 0 ? 0 : 1;
  } finally {
    await Promise.allSettled([appPool.end(), migratePool.end()]);
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
