// Sign-in is behind this interface. The real implementation (Clerk, verified on the server like the
// QenBel portal) arrives in a later stage. Only a development stub exists now (devAuth.ts).
//
// Rules this interface keeps:
//  - The browser never sends or chooses a tenant id or a role. The Session below is for display
//    (the business name in the top bar, hiding a button). The server decides what is allowed, on every route.
//  - No secrets are stored here.

export type DisplayRole = "OWNER" | "MANAGER" | "STAFF";

export interface Session {
  displayName: string;
  businessName: string;
  /** For display only. Never send it back to the server as proof of anything. */
  role: DisplayRole;
}

export interface SignInInput {
  email: string;
  password: string;
}

export class AuthError extends Error {
  readonly code: "NOT_CONFIGURED" | "INVALID" | "UNAVAILABLE";
  constructor(code: AuthError["code"], message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

export interface AuthProvider {
  readonly kind: "dev" | "clerk" | "none";
  getSession(): Promise<Session | null>;
  signIn(input: SignInInput): Promise<Session>;
  signOut(): Promise<void>;
}
