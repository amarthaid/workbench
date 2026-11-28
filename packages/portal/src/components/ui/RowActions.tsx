import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface RowActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Red text for a destructive action. Never a filled button. */
  danger?: boolean;
}

/** A text button for a list row. The same red-text style marks Delete, Revoke, Disable and Disconnect. */
export function RowAction({ danger, className, type = "button", ...rest }: RowActionProps) {
  const classes = ["ui-row-action", danger && "ui-row-action-danger", className].filter(Boolean).join(" ");
  return <button type={type} className={classes} {...rest} />;
}

/**
 * Groups a row's actions. With `reveal` they show on row hover, and also on
 * keyboard focus inside the row, so hover-only never means mouse-only.
 */
export function RowActions({ reveal, children }: { reveal?: boolean; children: ReactNode }) {
  return <div className={["ui-row-actions", reveal && "is-reveal"].filter(Boolean).join(" ")}>{children}</div>;
}
