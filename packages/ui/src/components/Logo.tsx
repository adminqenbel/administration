import { cx } from "../cx.ts";

export interface LogoProps {
  /** Small grey word after the name, e.g. "Administration". */
  suffix?: string;
  size?: "md" | "sm";
  className?: string;
}

/** The QenBel name set in type. No image mark. */
export function Logo({ suffix, size = "md", className }: LogoProps) {
  return (
    <span className={cx("qb-logo", size === "sm" && "qb-logo--sm", className)}>
      QenBel
      {suffix ? <span className="qb-logo__suffix">{suffix}</span> : null}
    </span>
  );
}
