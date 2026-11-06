import type { ButtonHTMLAttributes } from "react";
import { cx } from "../cx.ts";

export type ButtonVariant = "solid" | "ghost" | "outline" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  block?: boolean;
}

export function buttonClass(variant: ButtonVariant = "solid", size: "md" | "sm" = "md", block = false, extra?: string): string {
  return cx(
    "qb-btn",
    variant !== "solid" && `qb-btn--${variant}`,
    size === "sm" && "qb-btn--sm",
    block && "qb-btn--block",
    extra,
  );
}

export function Button({ variant = "solid", size = "md", block = false, type = "button", className, ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, block, className)} {...rest} />;
}
