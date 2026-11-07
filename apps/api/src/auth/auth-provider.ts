import type { AuthProviderKind } from "@qenbel/shared";

/** A verified identity: who the provider says this is. Not yet a principal (no tenant, no role). */
export interface VerifiedIdentity {
  provider: AuthProviderKind;
  subject: string;
  sessionId?: string | null;
}

export interface AuthRequestInfo {
  /** The bearer token, already extracted from `Authorization`. */
  token: string;
  /** Socket address of the peer (not a forwarded header). */
  remoteAddress: string | undefined;
}

/** Reason codes go to the server log only, never to the client. */
export class AuthError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "AuthError";
    this.reason = reason;
  }
}

export interface AuthProvider {
  readonly kind: AuthProviderKind;
  /** Verify the token ourselves. Throws AuthError. Makes no network call. */
  authenticate(info: AuthRequestInfo): Promise<VerifiedIdentity>;
}

export const MAX_TOKEN_LENGTH = 4096;
