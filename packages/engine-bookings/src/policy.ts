// Cancellation policy: what is snapshotted onto a booking at confirmation and how a cancellation is judged against it.
import { CancellationLate } from "@qenbel/shared";
import type { BookingConfig, CancellationPolicy } from "./config.ts";
import type { CancellationOutcome } from "./types.ts";

export interface PolicySnapshot extends CancellationPolicy {
  packId: string;
  packVersion: string;
  depositPaise: number;
  capturedAt: string;
}

export function buildSnapshot(cfg: BookingConfig, depositPaise: number, now: Date): PolicySnapshot {
  return {
    packId: cfg.pack.id,
    packVersion: cfg.pack.version,
    ...cfg.policy,
    depositPaise,
    capturedAt: now.toISOString(),
  };
}

function isLate(v: unknown): v is CancellationLate {
  return v === CancellationLate.ALLOW || v === CancellationLate.FLAG || v === CancellationLate.BLOCK;
}

/** Rules for an existing booking: its snapshot where present, today's rules for anything the snapshot lacks (for example a HOLD). */
export function policyFor(snapshot: Record<string, unknown> | null, cfg: BookingConfig): CancellationPolicy {
  const s = snapshot ?? {};
  const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : fallback);
  return {
    cancelUntilHoursBefore: int(s.cancelUntilHoursBefore, cfg.policy.cancelUntilHoursBefore),
    lateCancellation: isLate(s.lateCancellation) ? s.lateCancellation : cfg.policy.lateCancellation,
    lateFeePaise: int(s.lateFeePaise, cfg.policy.lateFeePaise),
    forfeitDepositOnLate: typeof s.forfeitDepositOnLate === "boolean" ? s.forfeitDepositOnLate : cfg.policy.forfeitDepositOnLate,
  };
}

export function hoursBefore(startsAtMs: number, nowMs: number): number {
  return (startsAtMs - nowMs) / 3_600_000;
}

/** Late means closer to the start than the free window allows (or already started). */
export function isLateChange(policy: CancellationPolicy, startsAtMs: number, nowMs: number): boolean {
  return hoursBefore(startsAtMs, nowMs) < policy.cancelUntilHoursBefore;
}

/**
 * What a cancellation costs. Free outside the window. Inside it:
 *  - `allow`: accepted, no fee.
 *  - `flag`: accepted and flagged; the fee is the fixed late fee, or the deposit when the policy forfeits it.
 *  - `block`: customers are refused by the caller (see cancelBooking); staff may still cancel and it is treated as `flag`.
 */
export function judgeCancellation(
  policy: CancellationPolicy,
  startsAtMs: number,
  nowMs: number,
  deposit: { paise: number; status: string },
): CancellationOutcome {
  const h = hoursBefore(startsAtMs, nowMs);
  const late = isLateChange(policy, startsAtMs, nowMs);
  let outcome: CancellationOutcome["outcome"] = "free";
  let feePaise = 0;
  if (late) {
    if (policy.lateCancellation === CancellationLate.ALLOW) {
      outcome = "late_allowed";
    } else {
      outcome = "late_flagged";
      feePaise = policy.lateFeePaise > 0 ? policy.lateFeePaise : policy.forfeitDepositOnLate ? deposit.paise : 0;
    }
  }
  const depositRefundPaise = deposit.status === "paid" ? Math.max(0, deposit.paise - Math.min(feePaise, deposit.paise)) : 0;
  return {
    outcome,
    late,
    hoursBeforeStart: Math.round(h * 100) / 100,
    feePaise,
    depositRefundPaise,
    cancelUntilHoursBefore: policy.cancelUntilHoursBefore,
    lateCancellation: policy.lateCancellation,
  };
}
