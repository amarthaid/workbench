import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "./Icons";

export interface PopoverSelectOption<T extends string | number> {
  value: T;
  label: string;
}

export interface PopoverSelectProps<T extends string | number> {
  value: T;
  options: PopoverSelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name for the trigger, e.g. "Expires after". */
  label: string;
  /** Leading icon in the trigger. */
  icon?: ReactNode;
  /** Trigger text for the current value. Defaults to the option's label. */
  display?: (option: PopoverSelectOption<T>) => ReactNode;
  disabled?: boolean;
}

/**
 * A compact select: a ghost trigger that opens a small listbox floating under
 * it. For a choice that sits beside an action (the one-time link's expiry
 * next to Create link) where a full-width <select> would read as a second
 * field. Closes on pick, Escape (focus back to the trigger) and outside click;
 * Arrow keys move between options.
 */
export function PopoverSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  icon,
  display,
  disabled,
}: PopoverSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const selected = list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    (selected ?? list.current?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
    function onDown(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === "Tab") return setOpen(false);
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? Math.min(at + 1, items.length - 1) : Math.max(at - 1, 0);
    items[next]?.focus();
  }

  return (
    <div className="ui-popselect" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="ui-popselect-trigger"
        aria-label={`${label}: ${current?.label ?? ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        <span>{current ? (display ? display(current) : current.label) : null}</span>
        {!disabled && <ChevronDownIcon />}
      </button>
      {open && (
        <div ref={list} id={listId} role="listbox" aria-label={label} className="ui-popselect-list" onKeyDown={onListKey}>
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={selected}
                className="ui-popselect-option"
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
              >
                <span>{o.label}</span>
                {selected && <CheckIcon />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
