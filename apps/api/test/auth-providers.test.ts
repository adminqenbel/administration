import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey } from "jose";
import { AuthError } from "../src/auth/auth-provider.ts";
import { createClerkProvider } from "../src/auth/clerk.provider.ts";
import { createDevProvider, isLoopbackPeer } from "../src/auth/dev.provider.ts";

const ISSUER = "https://clerk.example.test";
const AZP = "https://app.example.test";
const SUB = "user_2abcDEF123";

const main = await generateKeyPair("RS256", { extractable: true });
const other = await generateKeyPair("RS256", { extractable: true });
const mainPem = await exportSPKI(main.publicKey);

interface Claims {
  sub?: string | null;
  iss?: string | null;
  azp?: string | null;
  exp?: number | null;
  nbf?: number;
  sid?: string;
}

async function sign(claims: Claims = {}, key: CryptoKey = main.privateKey, alg = "RS256"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (claims.azp !== null) payload.azp = claims.azp ?? AZP;
  if (claims.sid) payload.sid = claims.sid;
  const jwt = new SignJWT(payload).setProtectedHeader({ alg, typ: "JWT" }).setIssuedAt(now - 10);
  if (claims.sub !== null) jwt.setSubject(claims.sub ?? SUB);
  if (claims.iss !== null) jwt.setIssuer(claims.iss ?? ISSUER);
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? now + 300);
  if (claims.nbf !== undefined) jwt.setNotBefore(claims.nbf);
  return jwt.sign(key);
}

const provider = createClerkProvider({ jwtKey: mainPem, issuer: ISSUER, authorizedParties: [AZP] });
const check = (token: string, remoteAddress = "203.0.113.9") => provider.authenticate({ token, remoteAddress });

async function reason(token: string): Promise<string> {
  try {
    await check(token);
  } catch (err) {
    assert.ok(err instanceof AuthError, "must be an AuthError, not a crash");
    return err.reason;
  }
  return "ACCEPTED";
}

describe("clerk provider: verifies the session token itself", () => {
  it("accepts a valid token and returns the Clerk user id", async () => {
    const id = await check(await sign({ sid: "sess_1" }));
    assert.deepEqual(id, { provider: "clerk", subject: SUB, sessionId: "sess_1" });
  });

  it("accepts a key stored with escaped newlines (as in an env file)", async () => {
    const p = createClerkProvider({ jwtKey: mainPem.replace(/\n/g, "\\n"), issuer: ISSUER, authorizedParties: [AZP] });
    assert.equal((await p.authenticate({ token: await sign(), remoteAddress: undefined })).subject, SUB);
  });

  it("refuses a token signed by another key (forged)", async () => {
    assert.equal(await reason(await sign({}, other.privateKey)), "bad_signature");
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const [h, , s] = (await sign()).split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "user_victim", iss: ISSUER, azp: AZP, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    assert.equal(await reason(`${h}.${forgedPayload}.${s}`), "bad_signature");
  });

  it("refuses an expired token", async () => {
    assert.equal(await reason(await sign({ exp: Math.floor(Date.now() / 1000) - 60 })), "token_expired");
  });

  it("refuses a token without an expiry", async () => {
    assert.notEqual(await reason(await sign({ exp: null })), "ACCEPTED");
  });

  it("refuses a token that is not valid yet (nbf)", async () => {
    assert.notEqual(await reason(await sign({ nbf: Math.floor(Date.now() / 1000) + 600 })), "ACCEPTED");
  });

  it("refuses the wrong issuer", async () => {
    assert.equal(await reason(await sign({ iss: "https://evil.example.test" })), "wrong_issuer");
  });

  it("refuses the wrong authorised party, and a missing one", async () => {
    assert.equal(await reason(await sign({ azp: "https://evil.example.test" })), "wrong_authorized_party");
    assert.equal(await reason(await sign({ azp: null })), "wrong_authorized_party");
  });

  it("refuses a subject that is not a Clerk user id, and a missing subject", async () => {
    assert.equal(await reason(await sign({ sub: "admin" })), "bad_subject");
    assert.equal(await reason(await sign({ sub: "user_1; drop table" })), "bad_subject");
    assert.notEqual(await reason(await sign({ sub: null })), "ACCEPTED");
  });

  it("refuses alg=none", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: SUB, iss: ISSUER, azp: AZP, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    assert.notEqual(await reason(token), "ACCEPTED");
  });

  it("refuses algorithm confusion: HS256 signed with the public key as the secret", async () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "HS256", typ: "JWT" });
    const body = enc({ sub: SUB, iss: ISSUER, azp: AZP, exp: Math.floor(Date.now() / 1000) + 300 });
    const sig = createHmac("sha256", mainPem).update(`${head}.${body}`).digest("base64url");
    assert.notEqual(await reason(`${head}.${body}.${sig}`), "ACCEPTED");
  });

  it("refuses garbage, empty and oversized tokens without throwing anything but AuthError", async () => {
    for (const t of ["", "abc", "a.b.c", "....", "x".repeat(5000)]) assert.notEqual(await reason(t), "ACCEPTED", t.slice(0, 10));
  });

  it("does not need the network: verification works with no connectivity", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network used");
    }) as typeof fetch;
    try {
      assert.equal((await check(await sign())).subject, SUB);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses to be built without a key, an issuer or an authorised party", () => {
    assert.throws(() => createClerkProvider({ jwtKey: "", issuer: ISSUER, authorizedParties: [AZP] }));
    assert.throws(() => createClerkProvider({ jwtKey: mainPem, issuer: "", authorizedParties: [AZP] }));
    assert.throws(() => createClerkProvider({ jwtKey: mainPem, issuer: ISSUER, authorizedParties: [] }));
  });
});

describe("dev provider", () => {
  const dev = createDevProvider({ nodeEnv: "development", host: "127.0.0.1" });

  it("accepts dev|<subject> from this machine only", async () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal((await dev.authenticate({ token: "dev|salon-owner", remoteAddress: addr })).subject, "dev|salon-owner");
    }
    for (const addr of ["10.0.0.5", "203.0.113.9", undefined, ""]) {
      await assert.rejects(dev.authenticate({ token: "dev|salon-owner", remoteAddress: addr }), (e: AuthError) => e.reason === "dev_not_local");
    }
  });

  it("refuses tokens that are not dev identities", async () => {
    for (const t of ["salon-owner", "dev|", "dev|a b", "dev|" + "x".repeat(80), "Dev|x", "user_123"]) {
      await assert.rejects(dev.authenticate({ token: t, remoteAddress: "127.0.0.1" }), AuthError, t);
    }
  });

  it("isLoopbackPeer", () => {
    assert.equal(isLoopbackPeer("127.0.0.1"), true);
    assert.equal(isLoopbackPeer("127.0.0.2"), false);
  });
});
