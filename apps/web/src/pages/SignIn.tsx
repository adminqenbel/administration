import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, Input, Logo } from "@qenbel/ui";
import { useAuth } from "../auth/AuthContext.tsx";
import { AuthError } from "../auth/AuthProvider.ts";
import { usePageTitle } from "../usePageTitle.ts";

export function SignIn() {
  usePageTitle("Sign in");
  const { state, signIn, providerKind } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  if (state.status === "signed-in") return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setEmailError("");
    setFormError("");
    if (!email.trim()) {
      setEmailError("Enter your email.");
      return;
    }
    setBusy(true);
    try {
      await signIn({ email: email.trim(), password });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith("/") && !from.startsWith("//") ? from : "/", { replace: true });
    } catch (err) {
      setFormError(err instanceof AuthError ? err.message : "Sign-in did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-page__top">
        <Logo suffix="Administration" />
      </div>
      <main className="auth-page__body" id="main">
        <div className="auth-card">
          <h1 className="auth-card__title">Sign in</h1>
          <p className="auth-card__lead">Use the account for your business.</p>
          {providerKind === "dev" ? <p className="notice">Development sign-in. Any email and password work, and nothing is checked.</p> : null}
          {providerKind === "none" ? <p className="notice">Sign-in is not set up yet.</p> : null}
          <form className="qb-form" onSubmit={(e) => void onSubmit(e)} noValidate>
            <Input label="Email" type="email" name="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} required />
            <Input label="Password" type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            {formError ? (
              <p className="qb-field__error" role="alert">
                {formError}
              </p>
            ) : null}
            <Button type="submit" disabled={busy} block>
              Sign in
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
