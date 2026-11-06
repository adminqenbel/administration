import { useState } from "react";
import type { FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button, ChoiceList, Logo } from "@qenbel/ui";
import { useAuth } from "../auth/AuthContext.tsx";
import { useBusiness } from "../business.tsx";
import { listPackOptions } from "../packs.ts";
import { LoadingPage } from "../Shell.tsx";
import { usePageTitle } from "../usePageTitle.ts";

export function Onboarding() {
  usePageTitle("Choose your business type");
  const { state } = useAuth();
  const { pack, choosePack } = useBusiness();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(pack?.id ?? null);
  const [error, setError] = useState("");

  if (state.status === "loading") return <LoadingPage />;
  if (state.status === "signed-out") return <Navigate to="/sign-in" replace />;

  const choices = listPackOptions().map((p) => ({ value: p.id, label: p.label, description: p.description }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selected) {
      setError("Choose the type that is closest to your business.");
      return;
    }
    choosePack(selected);
    navigate("/", { replace: true });
  }

  return (
    <div className="auth-page">
      <div className="auth-page__top">
        <Logo suffix="Administration" />
      </div>
      <main className="auth-page__body" id="main">
        <div className="auth-card">
          <h1 className="auth-card__title">Choose your business type</h1>
          <p className="auth-card__lead">This sets the words and screens you see. You can change it later in Settings.</p>
          <form className="qb-form" onSubmit={onSubmit}>
            <ChoiceList
              legend="Business type"
              name="business-type"
              choices={choices}
              value={selected}
              onChange={(v) => {
                setSelected(v);
                setError("");
              }}
              error={error}
            />
            <Button type="submit" block>
              Continue
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
