// Contract checks across every exported engine function. No database needed: a client that throws proves the
// function refused the call before touching SQL.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as engine from "../src/index.ts";
import { makeCtx } from "./helpers.ts";

/** Pure helpers and functions that take no caller input. Everything else is an `op` taking an input object. */
const PURE = new Set([
  "breaksOf", "emptyWeek", "generateAllSlots", "generateResourceSlots", "intersectIntervals", "maskEmail", "maskPhone", "normaliseEmail",
  "normalisePhone", "peakUnits", "readSettings", "slotRequestFor", "weekFromRows",
]);
/** Internal helpers that take a client and context but are not entry points. */
const INTERNAL = new Set(["insertNote", "readLocationHours", "loadWeeklyBreaks"]);
/** Entry points with no input object: nothing to smuggle a tenant id into. */
const NO_INPUT = new Set(["getBusinessProfile", "getBusinessProfileForChannel"]);

const exportedFunctions = Object.entries(engine).filter(([, v]) => typeof v === "function") as Array<[string, (...a: unknown[]) => Promise<unknown>]>;
const ops = exportedFunctions.filter(([name]) => !PURE.has(name) && !INTERNAL.has(name) && !NO_INPUT.has(name));

const poisoned = {
  query: () => {
    throw new Error("SQL must not be reached");
  },
};
const ctx = makeCtx("22222222-2222-2222-2222-222222222222");
const code = (err: unknown) => (err as { code?: string }).code;

test("every exported function is classified (a new export must be added to PURE, INTERNAL, NO_INPUT or be an op)", () => {
  assert.ok(ops.length >= 60, `expected many ops, found ${ops.length}`);
  for (const [name, fn] of ops) {
    // an op is `(sql, ctx, input)`: the wrapper has three declared parameters
    assert.equal(fn.length, 3, `${name} should be an engine op taking (sql, ctx, input)`);
  }
});

test("every op rejects a smuggled tenantId, tenant_id or role with VALIDATION_FAILED before any SQL", async () => {
  for (const [name, fn] of ops) {
    for (const extra of [{ tenantId: "33333333-3333-3333-3333-333333333333" }, { tenant_id: "33333333-3333-3333-3333-333333333333" }, { role: "OWNER" }]) {
      await assert.rejects(
        () => fn(poisoned, ctx, { ...extra }),
        (err) => code(err) === "VALIDATION_FAILED",
        `${name} accepted ${Object.keys(extra)[0]}`,
      );
    }
  }
});

test("every op rejects non-object input and an unusable context before any SQL", async () => {
  for (const [name, fn] of ops) {
    for (const input of [null, undefined, "x", 5, []]) {
      await assert.rejects(() => fn(poisoned, ctx, input), (err) => code(err) === "VALIDATION_FAILED", `${name} with ${JSON.stringify(input)}`);
    }
    for (const badCtx of [{ ...ctx, tenantId: "nope" }, { ...ctx, tenantId: "" }, null, undefined]) {
      await assert.rejects(() => fn(poisoned, badCtx, {}), (err) => code(err) === "TENANT_REQUIRED", `${name} with a bad context`);
    }
  }
  for (const name of NO_INPUT) {
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name]!;
    await assert.rejects(() => fn(poisoned, { ...ctx, tenantId: "nope" }), (err) => code(err) === "TENANT_REQUIRED");
  }
});

test("errors never carry database text: a pg-style failure becomes a plain AppError or passes through untouched only if unknown", async () => {
  const failing = {
    query: async () => {
      const e = new Error('duplicate key value violates unique constraint "customers_pkey" Key (phone)=(+919876543210)') as Error & { code: string; constraint: string };
      e.code = "23505";
      e.constraint = "customers_pkey";
      throw e;
    },
  };
  await assert.rejects(
    () => engine.listLocations(failing, ctx, {}),
    (err: { code?: string; message: string; details: Record<string, unknown> }) => {
      assert.equal(err.code, "CONFLICT");
      assert.ok(!err.message.includes("9876543210") && !err.message.includes("duplicate key"));
      return true;
    },
  );
});
