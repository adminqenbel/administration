import { cx } from "../cx.ts";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export type ToneMap = Readonly<Record<string, Tone>>;

export interface StatusBadgeProps {
  /** The raw status string, e.g. "CONFIRMED". */
  status: string;
  /** Status to tone. A status that is missing from the map shows as neutral. */
  tones: ToneMap;
  /** Optional words to show instead of the raw status (a pack may relabel a status). */
  labels?: Readonly<Record<string, string>>;
}

export function toneFor(status: string, tones: ToneMap): Tone {
  return tones[status] ?? "neutral";
}

/** The label is always text, so colour is never the only signal. */
export function StatusBadge({ status, tones, labels }: StatusBadgeProps) {
  const text = labels?.[status] ?? status;
  return <span className={cx("qb-badge", `qb-badge--${toneFor(status, tones)}`)}>{text}</span>;
}
