import { useState } from "react";
import type { FormEvent } from "react";
import { Button, Input, PageHeader, Select, Tabs, useToast } from "@qenbel/ui";
import { useBusiness } from "../business.tsx";
import { listPackOptions } from "../packs.ts";
import { usePageTitle } from "../usePageTitle.ts";
import { NotConnected } from "./parts.tsx";

const ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"] as const;

export function Settings() {
  const { terminology: t, pack, choosePack } = useBusiness();
  const { toast } = useToast();
  const [name, setName] = useState("");
  usePageTitle(t.settings);

  function saveBusiness(e: FormEvent) {
    e.preventDefault();
    toast({ message: "Saving is not connected yet.", tone: "info" });
  }

  const business = (
    <form className="qb-form" onSubmit={saveBusiness}>
      <Input label="Business name" name="business" value={name} onChange={(e) => setName(e.target.value)} autoComplete="organization" />
      <Select label="Time zone" name="timezone" defaultValue="Asia/Kolkata" hint="Opening hours and availability follow this zone.">
        {ZONES.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </Select>
      <div>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );

  const industry = (
    <div className="qb-form">
      <Select
        label="Business type"
        name="pack"
        value={pack?.id ?? ""}
        onChange={(e) => {
          choosePack(e.target.value);
          toast({ message: "Business type changed.", tone: "success" });
        }}
        hint="Changes the words and screens. Your data stays as it is."
      >
        {listPackOptions().map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    </div>
  );

  return (
    <>
      <PageHeader title={t.settings} description="Your business and how this app reads." />
      <Tabs
        label={t.settings}
        tabs={[
          { id: "business", label: "Business", panel: business },
          { id: "industry", label: "Business type", panel: industry },
        ]}
      />
      <div className="stack">
        <NotConnected />
      </div>
    </>
  );
}
