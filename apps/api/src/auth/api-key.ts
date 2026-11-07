// API credentials: a random secret shown once, stored only as a peppered HMAC. The public part
// (`lookupId`) is how a request finds its row; it is not secret and is globally unique.
//
//   key  = "qbk_" + 12 chars, ".", 43 chars   (lookup id, then 32 random bytes as base64url)
//   hash = HMAC-SHA256(API_KEY_PEPPER, lookupId + "." + secret), hex
//
// Binding the lookup id into the hash means a hash copied from one row does not verify under another.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "qbk_";
const KEY_RE = /^(qbk_[A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
const HEX_HASH_RE = /^[0-9a-f]{64}$/;

export interface GeneratedApiKey {
  /** The full key. Shown to the owner once; never stored, never logged. */
  key: string;
  lookupId: string;
  secretHash: string;
  pepperVersion: number;
}

export interface ParsedApiKey {
  lookupId: string;
  secret: string;
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const m = KEY_RE.exec(token);
  if (!m) return null;
  return { lookupId: m[1] as string, secret: m[2] as string };
}

export function hashApiKeySecret(pepper: string, lookupId: string, secret: string): string {
  return createHmac("sha256", pepper).update(`${lookupId}.${secret}`).digest("hex");
}

export function generateApiKey(pepper: string, pepperVersion: number): GeneratedApiKey {
  const lookupId = `${API_KEY_PREFIX}${randomBytes(9).toString("base64url")}`; // 12 chars after the prefix
  const secret = randomBytes(32).toString("base64url"); // 43 chars
  return {
    key: `${lookupId}.${secret}`,
    lookupId,
    secretHash: hashApiKeySecret(pepper, lookupId, secret),
    pepperVersion,
  };
}

/** Constant-time comparison of the presented secret against a stored hash. Never throws. */
export function verifyApiKeySecret(args: {
  pepper: string;
  lookupId: string;
  secret: string;
  storedHash: string | null;
}): boolean {
  const presented = Buffer.from(hashApiKeySecret(args.pepper, args.lookupId, args.secret), "hex");
  const storedValid = args.storedHash !== null && HEX_HASH_RE.test(args.storedHash);
  // Always compare something, so a missing row costs the same as a wrong secret.
  const stored = storedValid ? Buffer.from(args.storedHash as string, "hex") : Buffer.alloc(32);
  const equal = timingSafeEqual(presented, stored);
  return equal && storedValid;
}
