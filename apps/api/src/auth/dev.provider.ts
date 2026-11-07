// Fake identity for local development. `Authorization: Bearer dev|<subject>` names an identity that must
// already exist in the database (seeded users use dev|salon-owner and so on). It exists only when the process
// runs with NODE_ENV=development and listens on a loopback address, and it still refuses any peer that is
// not on this machine. A test proves it cannot be built otherwise.
import { AuthProviderKind } from "@qenbel/shared";
import { type AppConfig, isLoopbackHost } from "../config/config.ts";
import { type AuthProvider, AuthError, type AuthRequestInfo, type VerifiedIdentity } from "./auth-provider.ts";

const DEV_TOKEN_RE = /^dev\|[A-Za-z0-9._-]{1,64}$/;
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackPeer(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_PEERS.has(address);
}

export function createDevProvider(config: Pick<AppConfig, "nodeEnv" | "host">): AuthProvider {
  if (config.nodeEnv !== "development") {
    throw new Error("The dev auth provider can only be created when NODE_ENV=development.");
  }
  if (!isLoopbackHost(config.host)) {
    throw new Error("The dev auth provider can only be created when HOST is a loopback address.");
  }
  return {
    kind: AuthProviderKind.DEV,
    async authenticate(info: AuthRequestInfo): Promise<VerifiedIdentity> {
      if (!isLoopbackPeer(info.remoteAddress)) throw new AuthError("dev_not_local");
      if (!DEV_TOKEN_RE.test(info.token)) throw new AuthError("dev_bad_token");
      return { provider: AuthProviderKind.DEV, subject: info.token, sessionId: null };
    },
  };
}
