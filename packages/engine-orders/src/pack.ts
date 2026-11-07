// The tenant's config pack narrows the default order machine and supplies status labels and required customer
// fields. The pack id is read from the tenant row (RLS: the session's own tenant only).
import { getPack } from "@qenbel/config-packs";
import {
  AppError,
  ErrorCode,
  OrderMode,
  OrderStatus,
  allowedTransitions,
  defineMachine,
  orderMachine,
  type ConfigPack,
  type EngineContext,
  type Machine,
  type SqlClient,
} from "@qenbel/shared";
import { orderError } from "./common.ts";

/** Finds the pack for a tenant's pack id and version. The default reads the in-memory registry; the API may plug in packs stored in the database. */
export type PackResolver = (packId: string, packVersion: string | null) => ConfigPack;

let resolver: PackResolver = (packId) => getPack(packId);

/** Replace the pack resolver (null restores the registry). Process-wide: for the API bootstrap and for tests. */
export function setPackResolver(next: PackResolver | null): void {
  resolver = next ?? ((packId) => getPack(packId));
}

export interface PackContext {
  pack: ConfigPack | null;
  machine: Machine<OrderStatus>;
  label(status: OrderStatus): string;
  nextStatuses(status: OrderStatus): OrderStatus[];
}

/** The pack machine: the pack's transitions, which validatePack guarantees are a subset of the default. */
export function machineForPack(pack: ConfigPack | null): Machine<OrderStatus> {
  if (pack === null) return orderMachine;
  return defineMachine<OrderStatus>({
    initial: OrderStatus.DRAFT,
    transitions: pack.orderTransitions.transitions as Partial<Record<OrderStatus, readonly OrderStatus[]>>,
  });
}

function build(pack: ConfigPack | null): PackContext {
  const machine = machineForPack(pack);
  return {
    pack,
    machine,
    label: (status) => pack?.orderTransitions.labels[status] ?? status,
    nextStatuses: (status) => [...allowedTransitions(machine, status)],
  };
}

/**
 * Load the tenant's pack. `requireOrders` is true for anything that writes: a tenant with no pack, or whose pack
 * has orderMode "none", cannot create or change orders. Reads fall back to the default machine and raw labels.
 */
export async function loadPackContext(sql: SqlClient, ctx: EngineContext, requireOrders: boolean): Promise<PackContext> {
  const res = await sql.query<{ pack_id: string | null; pack_version: string | null }>(
    "select pack_id, pack_version from tenants where id = $1",
    [ctx.tenantId],
  );
  const packId = res.rows[0]?.pack_id ?? null;
  if (packId === null) {
    if (requireOrders) {
      throw orderError(ErrorCode.CONFLICT, "PACK_REQUIRED", "Choose a business type before taking orders.");
    }
    return build(null);
  }
  let pack: ConfigPack;
  try {
    pack = resolver(packId, res.rows[0]?.pack_version ?? null);
  } catch (err) {
    if (err instanceof AppError) throw new AppError(ErrorCode.PACK_INVALID, undefined, { reason: "PACK_UNKNOWN" });
    throw err;
  }
  if (requireOrders && pack.orderMode === OrderMode.NONE) {
    throw orderError(ErrorCode.CONFLICT, "ORDER_MODE_NOT_SUPPORTED", "This business does not take orders.");
  }
  return build(pack);
}
