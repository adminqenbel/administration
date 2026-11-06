// Industry config packs. Adding a pack: add a file in ./packs and an entry in `registry` below.
import { AppError, ErrorCode, parsePack, type ConfigPack } from "@qenbel/shared";
import { salon } from "./packs/salon.ts";
import { clinic } from "./packs/clinic.ts";
import { restaurant } from "./packs/restaurant.ts";
import { retail, hotel, homeServices, rental } from "./packs/stubs.ts";

export const packIds = ["salon", "clinic", "restaurant", "retail", "hotel", "home-services", "rental"] as const;
export type PackId = (typeof packIds)[number];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const source: Record<PackId, ConfigPack> = {
  salon,
  clinic,
  restaurant,
  retail,
  hotel,
  "home-services": homeServices,
  rental,
};

// Validate at load. A broken pack stops the process at start, never at request time.
const registry = new Map<PackId, ConfigPack>();
for (const id of packIds) {
  const pack = parsePack(source[id]);
  if (pack.id !== id) throw new Error(`Pack registered as "${id}" declares id "${pack.id}"`);
  registry.set(id, deepFreeze(pack));
}

export function isPackId(value: unknown): value is PackId {
  return typeof value === "string" && (packIds as readonly string[]).includes(value);
}

/** The validated, frozen pack. Throws AppError(NOT_FOUND) for an unknown id. */
export function getPack(id: string): ConfigPack {
  const pack = isPackId(id) ? registry.get(id) : undefined;
  if (!pack) throw new AppError(ErrorCode.NOT_FOUND, "Unknown config pack", { packId: String(id).slice(0, 64) });
  return pack;
}

/** All packs, in registry order. */
export function listPacks(): ConfigPack[] {
  return packIds.map((id) => getPack(id));
}
