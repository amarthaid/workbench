import type { ReactNode } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** Visible label elsewhere on the page: pass its id. */
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Accessible name when there is no visible label to point at. */
  "aria-label"?: string;
  children?: ReactNode;
}

// An on/off control. A native button with role="switch": Space and Enter
// toggle it, it takes focus in tab order, and a screen reader announces
// "on" / "off" from aria-checked.
export function Switch({ checked, onChange, disabled, id, children, ...aria }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      className={`ui-switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
      {...aria}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
      {children}
    </button>
  );
}
