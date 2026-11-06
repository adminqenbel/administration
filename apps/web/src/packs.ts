// Adapter between the app and industry config packs.
//
// The `core` agent is building @qenbel/config-packs in parallel. Until it is merged, this file holds a
// small local list so Onboarding and the navigation can work. When the package is ready, swap the body
// of listPackOptions() for a mapping over listPacks() from "@qenbel/config-packs" (id, label,
// terminology, bookingMode, orderMode) and delete LOCAL_PACKS. Nothing else in the app imports packs.

import { terminologyForPack } from "./terminology.ts";
import type { Terminology } from "./terminology.ts";
import type { Modules } from "./nav.ts";

export interface PackOption {
  id: string;
  label: string;
  description: string;
  terminology: Terminology;
  modules: Modules;
}

interface LocalPack {
  id: string;
  label: string;
  description: string;
  bookingMode: "slot" | "table" | "room" | "period" | "none";
  orderMode: "catalogue" | "dine_in" | "quote" | "rental" | "none";
}

const LOCAL_PACKS: ReadonlyArray<LocalPack> = [
  { id: "salon", label: "Salon", description: "Appointments with stylists and a list of services.", bookingMode: "slot", orderMode: "none" },
  { id: "clinic", label: "Clinic", description: "Appointments with doctors and a patient list.", bookingMode: "slot", orderMode: "none" },
  { id: "restaurant", label: "Restaurant", description: "Table reservations, a menu and a kitchen view.", bookingMode: "table", orderMode: "dine_in" },
];

export function listPackOptions(): ReadonlyArray<PackOption> {
  return LOCAL_PACKS.map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    terminology: terminologyForPack(p.id),
    modules: { bookings: p.bookingMode !== "none", orders: p.orderMode !== "none" },
  }));
}

export function getPackOption(id: string | null | undefined): PackOption | null {
  if (!id) return null;
  return listPackOptions().find((p) => p.id === id) ?? null;
}
