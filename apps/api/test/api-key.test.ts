import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { API_KEY_PREFIX, generateApiKey, hashApiKeySecret, looksLikeApiKey, parseApiKey, verifyApiKeySecret } from "../src/auth/api-key.ts";

const PEPPER = "a".repeat(40);

describe("API keys", () => {
  it("generates a random key with a public lookup id and a peppered hash", () => {
    const k = generateApiKey(PEPPER, 1);
    const parsed = parseApiKey(k.key);
    assert.ok(parsed);
    assert.equal(parsed.lookupId, k.lookupId);
    assert.ok(k.key.startsWith(API_KEY_PREFIX));
    assert.match(k.secretHash, /^[0-9a-f]{64}$/);
    assert.ok(!k.secretHash.includes(parsed.secret) && !k.key.includes(k.secretHash));
    assert.equal(k.pepperVersion, 1);
  });

  it("never repeats", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(PEPPER, 1).key));
    assert.equal(keys.size, 200);
  });

  it("verifies the right secret and rejects everything else", () => {
    const k = generateApiKey(PEPPER, 1);
    const p = parseApiKey(k.key);
    assert.ok(p);
    const ok = (over: Partial<Parameters<typeof verifyApiKeySecret>[0]>) =>
      verifyApiKeySecret({ pepper: PEPPER, lookupId: p.lookupId, secret: p.secret, storedHash: k.secretHash, ...over });
    assert.equal(ok({}), true);
    assert.equal(ok({ secret: p.secret.slice(0, -1) + (p.secret.endsWith("A") ? "B" : "A") }), false);
    assert.equal(ok({ pepper: "b".repeat(40) }), false);
    assert.equal(ok({ lookupId: "qbk_AAAAAAAAAAAA" }), false, "hash is bound to its lookup id");
    assert.equal(ok({ storedHash: null }), false);
    assert.equal(ok({ storedHash: "" }), false);
    assert.equal(ok({ storedHash: "zz" }), false);
    assert.equal(ok({ storedHash: "0".repeat(64) }), false);
    assert.equal(ok({ storedHash: k.secretHash.toUpperCase() }), false);
  });

  it("a hash copied to another row does not verify there", () => {
    const a = generateApiKey(PEPPER, 1);
    const b = generateApiKey(PEPPER, 1);
    const pb = parseApiKey(b.key);
    assert.ok(pb);
    assert.equal(verifyApiKeySecret({ pepper: PEPPER, lookupId: pb.lookupId, secret: pb.secret, storedHash: a.secretHash }), false);
  });

  it("rejects malformed keys", () => {
    for (const bad of ["", "qbk_", "qbk_short.secret", `qbk_AAAAAAAAAAAA.${"x".repeat(42)}`, `qbk_AAAAAAAAAAAA.${"x".repeat(44)}`, `qbk_AAAAAAAAAAAA ${"x".repeat(43)}`, `xyz_AAAAAAAAAAAA.${"x".repeat(43)}`]) {
      assert.equal(parseApiKey(bad), null, bad);
    }
    assert.equal(looksLikeApiKey("qbk_anything"), true);
    assert.equal(looksLikeApiKey("eyJhbGciOi"), false);
  });

  it("hash is deterministic for the same inputs", () => {
    assert.equal(hashApiKeySecret(PEPPER, "qbk_AAAAAAAAAAAA", "s"), hashApiKeySecret(PEPPER, "qbk_AAAAAAAAAAAA", "s"));
  });
});
