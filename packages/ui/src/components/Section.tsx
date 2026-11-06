import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="qb-section">
      <h2 className="qb-section__title">{title}</h2>
      {children}
    </section>
  );
}
