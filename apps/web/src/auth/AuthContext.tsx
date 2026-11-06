import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AuthProvider, Session, SignInInput } from "./AuthProvider.ts";

export type AuthState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; session: Session };

interface AuthContextValue {
  state: AuthState;
  signIn: (input: SignInInput) => Promise<void>;
  signOut: () => Promise<void>;
  providerKind: AuthProvider["kind"];
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProviderRoot({ provider, children }: { provider: AuthProvider; children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    provider
      .getSession()
      .then((s) => live && setState(s ? { status: "signed-in", session: s } : { status: "signed-out" }))
      .catch(() => live && setState({ status: "signed-out" }));
    return () => {
      live = false;
    };
  }, [provider]);

  const signIn = useCallback(
    async (input: SignInInput) => {
      const session = await provider.signIn(input);
      setState({ status: "signed-in", session });
    },
    [provider],
  );

  const signOut = useCallback(async () => {
    await provider.signOut();
    setState({ status: "signed-out" });
  }, [provider]);

  const value = useMemo(() => ({ state, signIn, signOut, providerKind: provider.kind }), [state, signIn, signOut, provider.kind]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside AuthProviderRoot");
  return v;
}
