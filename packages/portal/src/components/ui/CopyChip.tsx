import { useEffect, useRef, useState } from "react";
import { CopyIcon, CheckIcon } from "./Icons";
import { Tooltip } from "./Tooltip";

export interface CopyChipProps {
  /** What is shown and what is copied. */
  text: string;
  /** Accessible name of the button, e.g. "Copy reference". */
  label: string;
  /** Short hint shown on hover and focus. */
  tooltip?: string;
}

const FEEDBACK_MS = 1500;

/**
 * A monospace chip that copies its own text. If the clipboard is unavailable or
 * refuses, the text is selected instead so it can be copied by hand, and no
 * "Copied" is claimed.
 */
export function CopyChip({ text, label, tooltip }: CopyChipProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  function selectText() {
    const node = textRef.current;
    const sel = window.getSelection();
    if (!node || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
    } catch {
      selectText();
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
  }

  const button = (
    <button type="button" className={`ui-copy-chip${copied ? " is-copied" : ""}`} aria-label={label} onClick={() => void copy()}>
      <span ref={textRef} className="wb-mono ui-copy-chip-text">
        {copied ? "Copied" : text}
      </span>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
  return tooltip ? <Tooltip label={tooltip}>{button}</Tooltip> : button;
}
