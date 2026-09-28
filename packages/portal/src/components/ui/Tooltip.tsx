import { useId, useState, type ReactElement, type ReactNode } from "react";

export interface TooltipProps {
  /** The tip's text. Kept short — this is a label, not documentation. */
  label: ReactNode;
  /** Which side of the trigger the bubble sits on. */
  placement?: "top" | "bottom" | "left";
  children: ReactElement<{ "aria-describedby"?: string }>;
}

/**
 * A hint bubble on hover and on keyboard focus, naming what a control does.
 * For an icon-only button, whose glyph carries no words: the button keeps its
 * own aria-label, and the bubble is tied to it with aria-describedby so a
 * screen reader hears the name and then the explanation.
 *
 * Escape dismisses it, as a tooltip must be dismissible without moving the
 * pointer, and the bubble itself is inert (pointer-events: none) so it cannot
 * swallow the click it is describing.
 */
export function Tooltip({ label, placement = "bottom", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span
      className="ui-tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) setOpen(false);
      }}
    >
      <children.type {...children.props} aria-describedby={open ? id : undefined} />
      {open && (
        <span role="tooltip" id={id} className={`ui-tooltip ui-tooltip-${placement}`}>
          {label}
        </span>
      )}
    </span>
  );
}
