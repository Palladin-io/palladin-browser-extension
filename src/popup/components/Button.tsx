import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Spinner } from "./Spinner";

/**
 * The popup's button — a small, local mirror of the web panel `Button` (all
 * `sm`, no `md`). `loading` swaps the label for a spinner and disables the
 * control so an in-flight request can't be double-submitted.
 */
export type ButtonVariant = "accent" | "subtle" | "ghost" | "danger";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  /** Stretch to the container width (auth CTAs). */
  block?: boolean;
  /** Show a spinner and disable while a request is in flight. */
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "accent",
  block = false,
  loading = false,
  disabled,
  type = "button",
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const classes = [
    "btn",
    `btn--${variant}`,
    block ? "btn--block" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading}>
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
