import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "./pool.ts";

export const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "migrations");

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const NAME_RE = /^\d{3,}_[a-z0-9_]+\.sql$/;
// Arbitrary constant: serialises concurrent runners (two deploys, parallel test files).
const ADVISORY_LOCK_KEY = 7_452_019_331;

/**
 * Directory the runner reads. QENBEL_MIGRATIONS_DIR overrides it outside production, so a migration under development
 * can be tried on a scratch database without sitting in migrations/ (where every other test run would apply it to the shared database).
 */
export function migrationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QENBEL_MIGRATIONS_DIR;
  return override && env.NODE_ENV !== "production" ? path.resolve(override) : DEFAULT_MIGRATIONS_DIR;
}

export async function loadMigrations(dir: string = migrationsDir()): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) throw new Error(`Bad migration file name: ${name} (expected NNN_snake_case.sql)`);
    const sql = await readFile(path.join(dir, name), "utf8");
    // Normalise line endings so a checkout with CRLF does not change the checksum.
    const checksum = createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
    files.push({ name, sql, checksum });
  }
  return files;
}

/**
 * Apply every pending migration, in file-name order, each in its own transaction.
 * Idempotent: applied files are recorded in schema_migrations (name, checksum) and skipped.
 * An already-applied file whose content changed is an error: migrations are immutable once applied.
 * Must be given a pool connected as the owner role (qenbel_migrate).
 */
export async function runMigrations(pool: Pool, options: { dir?: string; log?: (line: string) => void } = {}): Promise<MigrationResult> {
  const log = options.log ?? (() => {});
  const files = await loadMigrations(options.dir);
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists schema_migrations (
          name        text primary key,
          checksum    text not null,
          applied_at  timestamptz not null default now()
        )`);
      const done = new Map<string, string>();
      for (const row of (await client.query<{ name: string; checksum: string }>("select name, checksum from schema_migrations")).rows) {
        done.set(row.name, row.checksum);
      }
      const result: MigrationResult = { applied: [], alreadyApplied: [] };
      for (const file of files) {
        const recorded = done.get(file.name);
        if (recorded !== undefined) {
          if (recorded !== file.checksum) {
            throw new Error(`Migration ${file.name} was changed after it was applied. Add a new migration instead.`);
          }
          result.alreadyApplied.push(file.name);
          continue;
        }
        log(`applying ${file.name}`);
        try {
          await client.query("BEGIN");
          await client.query(file.sql);
          await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file.name, file.checksum]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
        }
        result.applied.push(file.name);
      }
      return result;
    } finally {
      await client.query("select pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
