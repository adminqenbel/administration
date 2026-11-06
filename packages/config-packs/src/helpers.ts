import type { TimeInterval, Weekday, WeeklyHours } from "@qenbel/shared";

/** Opening hours from the open days only. Days not listed are closed. */
export function weekHours(open: Partial<Record<Weekday, TimeInterval[]>>): WeeklyHours {
  return {
    mon: open.mon ?? [],
    tue: open.tue ?? [],
    wed: open.wed ?? [],
    thu: open.thu ?? [],
    fri: open.fri ?? [],
    sat: open.sat ?? [],
    sun: open.sun ?? [],
  };
}

/** The same intervals on several days. */
export function sameOn(days: readonly Weekday[], ...intervals: TimeInterval[]): Partial<Record<Weekday, TimeInterval[]>> {
  const out: Partial<Record<Weekday, TimeInterval[]>> = {};
  for (const d of days) out[d] = intervals.map((i) => ({ ...i }));
  return out;
}
