import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../cx.ts";

export interface ChipProps {
  children: ReactNode;
  className?: string;
}

/** Static pill with a hairline border. */
export function Chip({ children, className }: ChipProps) {
  return <span className={cx("qb-chip", className)}>{children}</span>;
}

export interface ChipButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  pressed?: boolean;
}

/** A chip you can press, for filters. */
export function ChipButton({ pressed = false, type = "button", className, ...rest }: ChipButtonProps) {
  return <button type={type} aria-pressed={pressed} className={cx("qb-chip", className)} {...rest} />;
}

export function Chips({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="qb-chips" role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}
