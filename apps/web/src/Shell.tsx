import type { ReactElement } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { AppShell, Button, SkeletonLines } from "@qenbel/ui";
import { useAuth } from "./auth/AuthContext.tsx";
import { useBusiness } from "./business.tsx";
import type { Modules } from "./nav.ts";

export function LoadingPage() {
  return (
    <div className="loading-page">
      <div>
        <SkeletonLines lines={3} />
      </div>
    </div>
  );
}

/**
 * Wraps every signed-in screen. This is a convenience for the interface: it sends people to sign in
 * or to choose a business type. It is not security. The API checks the session and permission on every call.
 */
export function Shell() {
  const { state, signOut } = useAuth();
  const { pack, nav } = useBusiness();
  const location = useLocation();

  if (state.status === "loading") return <LoadingPage />;
  if (state.status === "signed-out") return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  if (!pack) return <Navigate to="/onboarding" replace />;

  return (
    <AppShell
      nav={nav}
      topBarEnd={
        <>
          <span className="qb-hide-mobile">{state.session.businessName}</span>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            Sign out
          </Button>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

/** Hides a screen whose module the chosen business type does not use. */
export function RequireModule({ module, element }: { module: keyof Modules; element: ReactElement }) {
  const { modules } = useBusiness();
  return modules[module] ? element : <Navigate to="/" replace />;
}
