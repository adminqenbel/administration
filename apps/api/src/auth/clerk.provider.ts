// Verifies a Clerk session token ourselves, as the QenBel portal does (D:\qenbel-portal\src\auth\clerk.js):
// signature against the instance public key (no network call), expiry, not-before, authorised party and
// issuer. Identity is the Clerk user id (`sub`) and nothing else: no header, email or claim names a tenant
// or a role. Stricter than the SDK in two places: the algorithm is pinned to RS256 and `azp` is required.
import type { KeyObject } from "node:crypto";
import { errors as joseErrors, jwtVerify } from "jose";
import { AuthProviderKind } from "@qenbel/shared";
import { type ClerkConfig, parsePublicKey } from "../config/config.ts";
import { type AuthProvider, AuthError, type AuthRequestInfo, MAX_TOKEN_LENGTH, type VerifiedIdentity } from "./auth-provider.ts";

const CLERK_SUBJECT_RE = /^user_[A-Za-z0-9]+$/;

export interface ClerkProviderOptions extends ClerkConfig {
  /** Seconds of clock skew tolerated for exp/nbf. Default 5. */
  clockToleranceSeconds?: number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export function createClerkProvider(options: ClerkProviderOptions): AuthProvider {
  if (!options.jwtKey || !options.issuer || options.authorizedParties.length === 0) {
    throw new Error("The clerk auth provider needs a jwt key, an issuer and at least one authorised party.");
  }
  const key: KeyObject = parsePublicKey(options.jwtKey);
  if (key.asymmetricKeyType !== "rsa") throw new Error("The clerk jwt key must be an RSA public key.");
  const parties = new Set(options.authorizedParties);
  const tolerance = options.clockToleranceSeconds ?? 5;

  return {
    kind: AuthProviderKind.CLERK,
    async authenticate(info: AuthRequestInfo): Promise<VerifiedIdentity> {
      const token = info.token;
      if (!token || token.length > MAX_TOKEN_LENGTH) throw new AuthError("bad_token");
      let payload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          algorithms: ["RS256"],
          issuer: options.issuer,
          clockTolerance: tolerance,
          currentDate: options.now?.(),
          requiredClaims: ["exp", "sub"],
        }));
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new AuthError("token_expired");
        if (err instanceof joseErrors.JWTClaimValidationFailed) {
          throw new AuthError(err.claim === "iss" ? "wrong_issuer" : `claim_${String(err.claim)}`);
        }
        if (err instanceof joseErrors.JWSSignatureVerificationFailed) throw new AuthError("bad_signature");
        throw new AuthError("token_invalid");
      }
      const azp = payload.azp;
      if (typeof azp !== "string" || !parties.has(azp)) throw new AuthError("wrong_authorized_party");
      const sub = payload.sub;
      if (typeof sub !== "string" || !CLERK_SUBJECT_RE.test(sub)) throw new AuthError("bad_subject");
      return {
        provider: AuthProviderKind.CLERK,
        subject: sub,
        sessionId: typeof payload.sid === "string" ? payload.sid : null,
      };
    },
  };
}
