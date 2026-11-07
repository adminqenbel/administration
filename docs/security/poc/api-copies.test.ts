// Security PoC for two small API helpers. apps/api uses decorators, which `node --test` cannot load without a build,
// so the code under test is COPIED here verbatim (with its source line) instead of imported. If the originals change,
// update the copies. No database needed.
//
//   node --test docs/security/poc/api-copies.test.ts
//
// [DEFECT SEC-018] tests assert the safe behaviour and FAIL today; they are marked `todo`.
import assert from "node:assert/strict";
import { test } from "node:test";

// ---- copy of apps/api/src/authz/access.guard.ts (assertNoTenantKeys, lines 22-45) ---------------------------------------
const TENANT_KEY_HINTS = ["tenantid", "orgid", "organizationid", "organisationid"];
function looksLikeTenantKey(key: string): boolean {
  const flat = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return TENANT_KEY_HINTS.some((hint) => flat.includes(hint));
}
function assertNoTenantKeys(value: unknown, depth = 0, budget = { n: 0 }): void {
  if (value === null || typeof value !== "object" || depth > 8) return;
  if (++budget.n > 5000) return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoTenantKeys(item, depth + 1, budget);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (looksLikeTenantKey(k)) throw new Error("VALIDATION_FAILED");
    assertNoTenantKeys(v, depth + 1, budget);
  }
}

test("[GUARD] a plain tenantId key in the body is refused", () => {
  assert.throws(() => assertNoTenantKeys({ a: 1, nested: { tenantId: "x" } }), /VALIDATION_FAILED/);
});

test(
  "[DEFECT SEC-018] the tenant-key scan cannot be skipped by padding the body (5000-node budget, depth 8)",
  { todo: "SEC-018: the scan silently stops after 5000 nested objects or 8 levels; strict zod schemas are the real control, but this is the stated second wall" },
  () => {
    // ~40 KB of padding objects first, then the smuggled key. Well under the 256 KB body limit.
    const padding = Array.from({ length: 6000 }, () => ({}));
    const body = { padding, items: [{ tenantId: "00000000-0000-0000-0000-000000000001" }] };
    assert.throws(() => assertNoTenantKeys(body), /VALIDATION_FAILED/, "tenantId was not noticed");
    let deep: Record<string, unknown> = { tenantId: "x" };
    for (let i = 0; i < 10; i++) deep = { a: deep };
    assert.throws(() => assertNoTenantKeys(deep), /VALIDATION_FAILED/, "tenantId at depth 11 was not noticed");
  },
);

// ---- copy of apps/api/src/common/logger.ts (scrubString PEM rule, lines 11-23) -----------------------------------------
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;
function scrubString(value: string): string {
  const out = value.replace(PEM, "[redacted-pem]");
  return out.length > 2000 ? `${out.slice(0, 2000)}...` : out; // truncation happens AFTER the regex ran over the whole input
}

test(
  "[DEFECT SEC-018] scrubbing a 238 KB error message takes well under 100 ms (today about 1 second: the PEM rule is quadratic and truncation comes after it)",
  { todo: "SEC-018: truncate to 2000 characters BEFORE running the scrubbers" },
  () => {
    const hostile = "-----BEGIN A-----".repeat(14_000);
    const t0 = process.hrtime.bigint();
    scrubString(hostile);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 100, `scrubString blocked the event loop for ${ms.toFixed(0)} ms`);
  },
);
