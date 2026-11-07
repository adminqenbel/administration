import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadMigrations, migrationsDir, runMigrations } from "../src/index.ts";
import { connectTestDb, type TestDb } from "./helpers.ts";

let db: TestDb;
before(async () => {
  db = await connectTestDb();
});
after(async () => {
  await db.close();
});

describe("migration runner", () => {
  it("is idempotent: a second run applies nothing", async () => {
    const res = await runMigrations(db.owner);
    assert.deepEqual(res.applied, []);
    const files = await loadMigrations();
    assert.equal(res.alreadyApplied.length, files.length);
  });

  it("records every file in schema_migrations, in order", async () => {
    const rows = (await db.owner.query<{ name: string }>("select name from schema_migrations order by name")).rows.map((r) => r.name);
    const files = (await readdir(migrationsDir())).filter((n) => n.endsWith(".sql")).sort();
    assert.deepEqual(rows, files);
  });

  it("concurrent runners are serialised and do not double-apply", async () => {
    const results = await Promise.all([runMigrations(db.owner), runMigrations(db.owner), runMigrations(db.owner)]);
    for (const r of results) assert.deepEqual(r.applied, []);
  });

  it("refuses a migration that was edited after it was applied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qenbel-mig-"));
    try {
      await cp(migrationsDir(), dir, { recursive: true });
      const target = path.join(dir, "002_platform.sql");
      await writeFile(target, `${await readFile(target, "utf8")}\n-- edited\n`);
      await assert.rejects(runMigrations(db.owner, { dir }), /changed after it was applied/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rolls back a failing migration completely and does not record it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qenbel-mig-"));
    try {
      await cp(migrationsDir(), dir, { recursive: true });
      await writeFile(path.join(dir, "999_broken.sql"), "create table should_be_rolled_back (id int);\nselect 1/0;\n");
      await assert.rejects(runMigrations(db.owner, { dir }), /999_broken.sql failed/);
      const t = await db.owner.query("select to_regclass('public.should_be_rolled_back') as t");
      assert.equal(t.rows[0]?.t, null);
      const rec = await db.owner.query("select 1 from schema_migrations where name = '999_broken.sql'");
      assert.equal(rec.rowCount, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects badly named migration files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "qenbel-mig-"));
    try {
      await writeFile(path.join(dir, "bad name.sql"), "select 1");
      await assert.rejects(loadMigrations(dir), /Bad migration file name/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
