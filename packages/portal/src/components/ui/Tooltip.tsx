import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface TooltipProps {
  /** The tip's text. Kept short — this is a label, not documentation. */
  label: ReactNode;
  /** Which side of the trigger the bubble sits on. */
  placement?: "top" | "bottom" | "left";
  children: ReactElement<{ "aria-describedby"?: string }>;
}

const GAP = 4;
const GAP_LEFT = 8;

/**
 * Where the bubble goes, in viewport coordinates. Top and bottom align the
 * bubble's right edge with the trigger's; left centres it vertically.
 */
function place(r: DOMRect, placement: NonNullable<TooltipProps["placement"]>): CSSProperties {
  switch (placement) {
    case "top":
      return { top: r.top - GAP, left: r.right, transform: "translate(-100%, -100%)" };
    case "left":
      return { top: r.top + r.height / 2, left: r.left - GAP_LEFT, transform: "translate(-100%, -50%)" };
    default:
      return { top: r.bottom + GAP, left: r.right, transform: "translateX(-100%)" };
  }
}

/**
 * A hint bubble on hover and on keyboard focus, naming what a control does.
 * For an icon-only button, whose glyph carries no words: the button keeps its
 * own aria-label, and the bubble is tied to it with aria-describedby so a
 * screen reader hears the name and then the explanation.
 *
 * The bubble is portalled to <body> and positioned fixed from the trigger's
 * rect: a card clips its content (.ui-box has overflow: hidden, for its
 * rounded corners), and a bubble rendered inside one was cut off at the edge.
 *
 * Escape dismisses it, as a tooltip must be dismissible without moving the
 * pointer, and the bubble itself is inert (pointer-events: none) so it cannot
 * swallow the click it is describing.
 */
export function Tooltip({ label, placement = "bottom", children }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    function update() {
      if (wrapRef.current) setStyle(place(wrapRef.current.getBoundingClientRect(), placement));
    }
    update();
    // Fixed positioning does not follow the trigger on its own.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, placement]);

  return (
    <span
      ref={wrapRef}
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
      {open &&
        createPortal(
          <span role="tooltip" id={id} className="ui-tooltip" style={{ position: "fixed", ...style }}>
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
