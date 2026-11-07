// Per-tenant booking configuration: the config pack (defaults, required fields, narrowed state machine)
// plus the tenant's own overrides stored in tenants.settings.bookings.
import { z } from "zod";
import { getPack } from "@qenbel/config-packs";
import {
  AppError,
  BookingMode,
  BookingStatus,
  CancellationLate,
  ErrorCode,
  defineMachine,
  timeIntervalSchema,
  type ConfigPack,
  type CustomerField,
  type EngineContext,
  type Machine,
  type SqlClient,
  type TimeInterval,
} from "@qenbel/shared";
import { DEFAULT_LIMITS, type BookingLimits } from "./access.ts";
import type { AvailabilityDataSource } from "./availability-source.ts";

/** Optional injection points. The API passes its cached pack; tests pass narrowed packs. */
export interface EngineOptions {
  /** Use this pack instead of resolving tenants.pack_id from the registry. */
  pack?: ConfigPack;
  /** Replace the reader for hours, holidays, time off and allocations (the catalogue engine's loader, later). */
  availability?: AvailabilityDataSource;
}

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** tenants.settings.bookings. Every key is optional; a pack default applies when absent. */
export const bookingSettingsSchema = z
  .object({
    holdMinutes: z.number().int().min(1).max(120),
    /** Customer channels cannot book sooner than this many minutes from now. Default 0. */
    leadTimeMinutes: z.number().int().min(0).max(60 * 24 * 30),
    /** Customer channels cannot book further out than this many days. Default 90. */
    maxAdvanceDays: z.number().int().min(1).max(730),
    stepMinutes: z.number().int().min(5).max(240),
    /** Daily breaks (local time) that apply to every resource that has no breaks of its own. */
    breaks: z.array(timeIntervalSchema).max(10),
    cancellationPolicy: z
      .object({
        cancelUntilHoursBefore: z.number().int().min(0).max(720),
        lateCancellation: z.enum(CancellationLate),
        /** Fixed fee for a late cancellation, in paise. */
        lateFeePaise: paise,
        /** A late cancellation forfeits the deposit. Default true. */
        forfeitDepositOnLate: z.boolean(),
      })
      .partial()
      .strict(),
    /**
     * Limits for customer channels (web_chat, whatsapp, voice). Live holds and active (future confirmed or checked-in, plus
     * live holds) bookings per conversation, per verified customer, per credential and per tenant; see src/access.ts.
     */
    limits: z
      .object({
        holdsPerConversation: z.number().int().min(1).max(20),
        holdsPerCustomer: z.number().int().min(1).max(50),
        holdsPerCredential: z.number().int().min(1).max(1000),
        holdsPerTenant: z.number().int().min(1).max(10_000),
        activeBookingsPerCustomer: z.number().int().min(1).max(200),
        activeBookingsPerConversation: z.number().int().min(1).max(200),
        /** Hold length for a customer channel with no verified customer (capped by holdMinutes). */
        unverifiedHoldMinutes: z.number().int().min(1).max(120),
        resourcesPerHold: z.number().int().min(1).max(10),
      })
      .partial()
      .strict(),
    deposit: z
      .object({
        /** Share of the service price, in basis points. */
        percentBps: z.number().int().min(0).max(10_000),
        /** Fixed amount in paise. Used when percentBps is absent. */
        fixedPaise: paise,
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type BookingSettings = z.infer<typeof bookingSettingsSchema>;

export interface CancellationPolicy {
  cancelUntilHoursBefore: number;
  lateCancellation: CancellationLate;
  lateFeePaise: number;
  forfeitDepositOnLate: boolean;
}

export interface BookingConfig {
  pack: ConfigPack;
  machine: Machine<BookingStatus>;
  tenantTimezone: string;
  holdMinutes: number;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  stepMinutes: number;
  defaultDurationMinutes: number;
  defaultBufferMinutes: number;
  breaks: TimeInterval[];
  policy: CancellationPolicy;
  deposit: { percentBps: number | null; fixedPaise: number | null };
  requiredCustomerFields: readonly CustomerField[];
  limits: BookingLimits;
}

/** The pack's booking machine, narrowed as the pack says. Initial state is always HOLD. */
export function machineForPack(pack: ConfigPack): Machine<BookingStatus> {
  const transitions: Partial<Record<BookingStatus, readonly BookingStatus[]>> = {};
  for (const [from, to] of Object.entries(pack.bookingTransitions.transitions) as [BookingStatus, BookingStatus[] | undefined][]) {
    if (to !== undefined) transitions[from] = to;
  }
  return defineMachine<BookingStatus>({ initial: BookingStatus.HOLD, transitions });
}

export async function loadConfig(sql: SqlClient, ctx: EngineContext, options: EngineOptions = {}): Promise<BookingConfig> {
  const res = await sql.query<{ pack_id: string | null; default_timezone: string; settings: unknown }>(
    "select pack_id, default_timezone, settings from tenants where id = $1",
    [ctx.tenantId],
  );
  const row = res.rows[0];
  if (!row) throw new AppError(ErrorCode.TENANT_REQUIRED);

  let pack = options.pack;
  if (!pack) {
    if (row.pack_id === null) throw new AppError(ErrorCode.PACK_INVALID, "No config pack is set for this business.");
    pack = getPack(row.pack_id);
  }
  if (pack.bookingMode === BookingMode.NONE) {
    throw new AppError(ErrorCode.TOOL_NOT_ENABLED, "Bookings are not turned on for this business.");
  }

  const rawSettings = row.settings !== null && typeof row.settings === "object" ? (row.settings as Record<string, unknown>) : {};
  const parsed = bookingSettingsSchema.safeParse(rawSettings.bookings ?? {});
  if (!parsed.success) {
    throw new AppError(ErrorCode.PACK_INVALID, "The booking settings for this business are not valid.", { setting: "bookings" });
  }
  const s = parsed.data;
  const d = pack.defaults;
  return {
    pack,
    machine: machineForPack(pack),
    tenantTimezone: row.default_timezone,
    holdMinutes: s.holdMinutes ?? d.holdMinutes,
    leadTimeMinutes: s.leadTimeMinutes ?? 0,
    maxAdvanceDays: s.maxAdvanceDays ?? 90,
    stepMinutes: s.stepMinutes ?? d.stepMinutes,
    defaultDurationMinutes: d.defaultDurationMinutes,
    defaultBufferMinutes: d.bufferMinutes,
    breaks: s.breaks ?? [],
    policy: {
      cancelUntilHoursBefore: s.cancellationPolicy?.cancelUntilHoursBefore ?? d.cancellationPolicy.cancelUntilHoursBefore,
      lateCancellation: s.cancellationPolicy?.lateCancellation ?? d.cancellationPolicy.lateCancellation,
      lateFeePaise: s.cancellationPolicy?.lateFeePaise ?? 0,
      forfeitDepositOnLate: s.cancellationPolicy?.forfeitDepositOnLate ?? true,
    },
    deposit: { percentBps: s.deposit?.percentBps ?? null, fixedPaise: s.deposit?.fixedPaise ?? null },
    requiredCustomerFields: pack.requiredCustomerFields,
    limits: { ...DEFAULT_LIMITS, ...s.limits },
  };
}
