import { AuthError } from "./AuthProvider.ts";
import type { AuthProvider } from "./AuthProvider.ts";
import { createDevAuthProvider, devAuthAllowed } from "./devAuth.ts";

/** Used when no real provider is wired yet and the dev stub is not allowed. Nobody can sign in. */
export const unconfiguredAuthProvider: AuthProvider = {
  kind: "none",
  async getSession() {
    return null;
  },
  async signIn() {
    throw new AuthError("NOT_CONFIGURED", "Sign-in is not set up yet.");
  },
  async signOut() {
    /* nothing to do */
  },
};

/**
 * Picks the provider for this build. Today: the dev stub under the dev server on localhost,
 * otherwise "not set up". The Clerk provider is added here in a later stage.
 */
export function createAuthProvider(env: { dev: boolean; hostname: string }): AuthProvider {
  if (devAuthAllowed(env)) return createDevAuthProvider(env);
  return unconfiguredAuthProvider;
}
