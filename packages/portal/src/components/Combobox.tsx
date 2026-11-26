import { useId, useRef, useState, type ReactNode } from "react";
import "./activity-filters.css";

export interface ComboOption {
  value: string;
  label: string;
  /** Muted text at the right of the row. */
  meta?: ReactNode;
  /** Small badge before the meta, e.g. "Disabled". */
  badge?: ReactNode;
}

export interface ComboboxProps {
  /** Id of the input, so a <label htmlFor> names it. */
  id?: string;
  /** Accessible name when there is no <label>. */
  "aria-label"?: string;
  placeholder?: string;
  /** The committed value, shown while the list is closed. */
  value: string;
  /** What to show for the committed value; defaults to the value itself. */
  displayValue?: string;
  options: ComboOption[];
  onSelect: (value: string) => void;
  /** The box was emptied by the user. */
  onClear?: () => void;
  /** Every edit of the typed text. */
  onQueryChange?: (query: string) => void;
  /** The box gained focus and opened its list. */
  onOpen?: () => void;
  /**
   * Enter with no option highlighted, e.g. a full address typed by hand.
   * Return true when the text was accepted.
   */
  onSubmitText?: (text: string) => boolean;
  /** Shown while options are on their way and none are on screen. */
  loading?: boolean;
  loadingText?: ReactNode;
  /** Replaces the options with a message, e.g. "Type 2 or more characters". */
  notice?: ReactNode;
  /** Shown when there is nothing to list and no notice. */
  emptyState?: ReactNode;
  /** Hint row under the options. */
  footer?: ReactNode;
}

/** Wrap the first case-insensitive match of `q` in <mark>. */
function highlight(text: string, q: string): ReactNode {
  const needle = q.trim().toLowerCase();
  const i = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + needle.length)}</mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/**
 * An accessible combobox with a listbox: Up and Down move the highlight, Enter
 * picks, Esc closes the list. Keys handled here never reach document-level
 * shortcuts (the detail drawer's arrows, the popover's Esc) while the list is
 * open or the key is one the box owns.
 */
export function Combobox({
  id,
  "aria-label": ariaLabel,
  placeholder,
  value,
  displayValue,
  options,
  onSelect,
  onClear,
  onQueryChange,
  onOpen,
  onSubmitText,
  loading,
  loadingText = "Searching…",
  notice,
  emptyState,
  footer,
}: ComboboxProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  const optionId = (i: number) => `${autoId}-opt-${i}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = notice ? [] : options;
  const activeIndex = Math.min(active, Math.max(shown.length - 1, 0));
  const activeOption = shown[activeIndex];

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function pick(v: string) {
    onSelect(v);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Always owned by the box, open or not: the drawer must not step rows.
      e.preventDefault();
      e.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      const n = shown.length;
      if (n === 0) return;
      setActive(e.key === "ArrowDown" ? Math.min(n - 1, activeIndex + 1) : Math.max(0, activeIndex - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (open && activeOption) pick(activeOption.value);
      else if (onSubmitText && query.trim() && onSubmitText(query)) close();
    } else if (e.key === "Escape") {
      // Closing the list is this key's whole job; with the list shut it falls
      // through so the popover or drawer around it can close.
      if (open) {
        e.stopPropagation();
        close();
      }
    }
  }

  return (
    <div className="af-combo">
      <input
        ref={inputRef}
        id={id}
        className="ui-input"
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeOption ? optionId(activeIndex) : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={open ? query : (displayValue ?? value)}
        onFocus={() => {
          if (!open) {
            setOpen(true);
            onOpen?.();
          }
        }}
        onBlur={close}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
          onQueryChange?.(e.target.value);
          if (e.target.value === "" && value) onClear?.();
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul className="af-list" role="listbox" id={listId} aria-label={ariaLabel}>
          {notice ? (
            <li className="af-note" role="presentation">{notice}</li>
          ) : shown.length > 0 ? (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={i === activeIndex}
                className={`af-opt${i === activeIndex ? " is-active" : ""}`}
                // mousedown, not click: the input would blur and close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o.value);
                }}
                onMouseMove={() => setActive(i)}
              >
                <span>{highlight(o.label, query)}</span>
                <span className="af-sub">
                  {o.badge}
                  {o.meta}
                </span>
              </li>
            ))
          ) : loading ? (
            <li className="af-note" role="presentation">{loadingText}</li>
          ) : (
            <li className="af-note" role="presentation">{emptyState ?? "Nothing matches."}</li>
          )}
          {footer && shown.length > 0 && (
            <li className="af-hint" role="presentation">{footer}</li>
          )}
        </ul>
      )}
    </div>
  );
}
