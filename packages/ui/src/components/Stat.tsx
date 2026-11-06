import type { ReactNode } from "react";

export function Stats({ children }: { children: ReactNode }) {
  return <dl className="qb-stats">{children}</dl>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="qb-stat">
      <dt className="qb-stat__label">{label}</dt>
      <dd className="qb-stat__value">{value}</dd>
    </div>
  );
}
