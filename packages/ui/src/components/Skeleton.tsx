import { cx } from "../cx.ts";

export interface SkeletonProps {
  /** Width as a fraction class: s 30%, m 60%, l 85%, full 100%. */
  width?: "s" | "m" | "l" | "full";
  tall?: boolean;
  className?: string;
}

/** A flat placeholder block. Hidden from assistive tech; pair it with a live "Loading" message. */
export function Skeleton({ width = "full", tall = false, className }: SkeletonProps) {
  return <span aria-hidden="true" className={cx("qb-skeleton", `qb-skeleton--w-${width}`, tall && "qb-skeleton--tall", className)} />;
}

export function SkeletonLines({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  const widths = ["full", "l", "m", "s"] as const;
  return (
    <div className="qb-skeleton-group" role="status">
      <span className="qb-sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={widths[i % widths.length] ?? "full"} />
      ))}
    </div>
  );
}
