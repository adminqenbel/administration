import { Section, StatusBadge } from "@qenbel/ui";
import type { ToneMap } from "@qenbel/ui";
import { statusLabels } from "../status.ts";

/** A short list of every status in the words this business uses. */
export function StatusKey({ title, statuses, tones, overrides }: { title: string; statuses: ReadonlyArray<string>; tones: ToneMap; overrides: Readonly<Record<string, string>> }) {
  const labels = statusLabels(statuses, overrides);
  return (
    <Section title={title}>
      <ul className="status-key">
        {statuses.map((s) => (
          <li key={s}>
            <StatusBadge status={s} tones={tones} labels={labels} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function NotConnected() {
  return <p className="notice">This screen shows its layout only. It is not connected to the server yet.</p>;
}
