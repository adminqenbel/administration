// Contract for engines (pure TS domain services). Engines never open connections or read env:
// the caller (API, worker, agent runtime) passes a tenant-scoped SQL client and a context.
import type { Channel, PrincipalKind } from "./enums.ts";

/** Minimal SQL client. A `pg` PoolClient inside `withTenant` satisfies this. */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

export interface EngineActor {
  kind: PrincipalKind;
  /** user id, api credential id, or "system"/job name */
  id: string;
  /** channel the action came from (dashboard, web_chat, whatsapp, voice, api) */
  channel: Channel;
}

/**
 * Context for one engine call. `tenantId` is taken from the authenticated principal by the caller and
 * is already set on the SQL client via `withTenant`; engines use it for inserts and never accept it from input.
 */
export interface EngineContext {
  tenantId: string;
  actor: EngineActor;
  /** injected clock for deterministic tests */
  now: () => Date;
  /** injected id generator (defaults to crypto.randomUUID in callers) */
  newId: () => string;
  idempotencyKey?: string;
  /**
   * The verified end customer on whose behalf a customer-channel call runs (web_chat, whatsapp, voice).
   * Set ONLY by the channel layer from the verified contact (e.g. the WhatsApp sender number matched to a
   * customer, or the voice caller id), never from model/tool arguments. Customer-scoped engine operations
   * (cancel/reschedule/confirm a booking, view/cancel an order, customer search) MUST fail closed on
   * customer channels when this is missing or does not own the target. Staff on the dashboard do not use it.
   */
  subject?: { customerId?: string; conversationId?: string };
}

/** Domain event written to outbox_events by engines in the same transaction as the change. */
export interface DomainEventInput {
  type: string;
  aggregateType: "booking" | "order" | "customer" | "payment";
  aggregateId: string;
  payload: Record<string, unknown>;
}
