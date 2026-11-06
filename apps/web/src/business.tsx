import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { getPackOption } from "./packs.ts";
import type { PackOption } from "./packs.ts";
import { buildNav, ALL_MODULES } from "./nav.ts";
import type { Modules } from "./nav.ts";
import { DEFAULT_TERMINOLOGY } from "./terminology.ts";
import type { Terminology } from "./terminology.ts";
import type { NavItem } from "@qenbel/ui";

// The chosen business type. For now it is remembered in this browser only (a per-viewer convenience).
// Later stages store it on the server with the business profile and read it from the API.

const KEY = "qenbel.pack";

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}
function writeStored(id: string): void {
  try {
    globalThis.localStorage?.setItem(KEY, id);
  } catch {
    /* ignore */
  }
}

interface BusinessValue {
  pack: PackOption | null;
  terminology: Terminology;
  modules: Modules;
  nav: NavItem[];
  choosePack: (id: string) => void;
}

const BusinessContext = createContext<BusinessValue | null>(null);

export function BusinessProvider({ children }: { children: ReactNode }) {
  const [packId, setPackId] = useState<string | null>(() => readStored());
  const pack = getPackOption(packId);
  const terminology = pack?.terminology ?? DEFAULT_TERMINOLOGY;
  const modules = pack?.modules ?? ALL_MODULES;

  const choosePack = useCallback((id: string) => {
    if (!getPackOption(id)) return;
    writeStored(id);
    setPackId(id);
  }, []);

  const value = useMemo<BusinessValue>(
    () => ({ pack, terminology, modules, nav: buildNav(terminology, modules), choosePack }),
    [pack, terminology, modules, choosePack],
  );
  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>;
}

export function useBusiness(): BusinessValue {
  const v = useContext(BusinessContext);
  if (!v) throw new Error("useBusiness must be used inside BusinessProvider");
  return v;
}
