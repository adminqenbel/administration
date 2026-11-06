import { AuthError } from "./AuthProvider.ts";
import type { AuthProvider, Session, SignInInput } from "./AuthProvider.ts";

// Development stub. It accepts any email and password and gives a fake identity, so screens can be
// built before real sign-in exists. It must never run in a production build or on a real host:
// createDevAuthProvider throws unless BOTH the dev server flag is on and the host is this machine.
// (The API's dev auth has the same rule: NODE_ENV=development and bound to localhost.)

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface DevEnv {
  /** import.meta.env.DEV: true only under `vite` (dev server), false in builds and preview. */
  dev: boolean;
  /** location.hostname */
  hostname: string;
}

export function devAuthAllowed(env: DevEnv): boolean {
  return env.dev === true && LOCAL_HOSTS.has(env.hostname);
}

export interface SessionStore {
  get(): string | null;
  set(value: string): void;
  clear(): void;
}

const KEY = "qenbel.dev.session";

/** sessionStorage with every access guarded (it can throw or be empty in private windows). */
export function browserSessionStore(): SessionStore {
  return {
    get() {
      try {
        return globalThis.sessionStorage?.getItem(KEY) ?? null;
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        globalThis.sessionStorage?.setItem(KEY, value);
      } catch {
        /* ignore */
      }
    },
    clear() {
      try {
        globalThis.sessionStorage?.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

export function createDevAuthProvider(env: DevEnv, store: SessionStore = browserSessionStore()): AuthProvider {
  if (!devAuthAllowed(env)) {
    throw new AuthError("NOT_CONFIGURED", "The development sign-in cannot run here.");
  }
  return {
    kind: "dev",
    async getSession() {
      const raw = store.get();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<Session>;
        if (typeof parsed.displayName === "string" && typeof parsed.businessName === "string") {
          return { displayName: parsed.displayName, businessName: parsed.businessName, role: "OWNER" };
        }
      } catch {
        /* fall through */
      }
      return null;
    },
    async signIn(input: SignInInput) {
      const email = input.email.trim();
      if (!email) throw new AuthError("INVALID", "Enter your email.");
      const session: Session = { displayName: email.split("@")[0] || "Dev user", businessName: "Demo business", role: "OWNER" };
      store.set(JSON.stringify(session));
      return session;
    },
    async signOut() {
      store.clear();
    },
  };
}
