import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  dismissible?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, size = "md", dismissible = true, children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  const triggerRef = useRef<Element | null>(null);

  // The open effect must run on open and only on open. Call sites pass a fresh
  // onClose on every render (an inline closure over their own state), and a
  // dependency on it made each parent re-render — every keystroke in a form
  // inside the modal — re-run the effect and pull focus back to the panel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // Remember what had focus so it can be restored on close. Captured here
    // rather than in a handler because by close time the trigger may already
    // have re-rendered.
    triggerRef.current = document.activeElement;
    panelRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Return focus to the trigger. A call site that navigates or replaces the
      // page on close has no live trigger left, and focus() on a detached node
      // is a no-op — so this is safe there and load-bearing for a dialog the
      // page outlives, e.g. cancelling a delete confirmation.
      const trigger = triggerRef.current;
      triggerRef.current = null;
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="ui-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        className={`ui-modal ui-modal-${size}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="ui-modal-head">
            <h2 className="ui-modal-title">{title}</h2>
            {dismissible && (
              <button type="button" className="ui-button ui-button-ghost ui-button-sm" onClick={onClose} aria-label="Close">
                Close
              </button>
            )}
          </div>
        )}
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Focus returns to the trigger on close. This was originally deferred, because every call
// site at the time replaced or navigated away from the page on close and so had no live
// trigger to return to. The delete confirmation on the Files page is the call site that
// needed it: the page outlives the dialog, so cancelling used to drop focus to the document
// body and leave a keyboard user stranded at the top of the page.
