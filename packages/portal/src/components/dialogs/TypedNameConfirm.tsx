import { useId, useState, type ReactNode } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

export interface TypedNameConfirmProps {
  title: ReactNode;
  /** The exact text that must be typed (case-sensitive). */
  name: string;
  /** What the name is called in the prompt: "Type the <nameLabel> <name> to confirm". */
  nameLabel?: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string | null;
  /** What goes with it: a list of consequences, shown between the body and the input. */
  impact?: ReactNode;
  /** The explanation shown first. */
  children?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The third and strongest confirm level, for irreversible things with
 * dependents. The red button stays off until the name is typed exactly.
 */
export function TypedNameConfirm({
  title,
  name,
  nameLabel = "name",
  confirmLabel,
  busyLabel,
  busy = false,
  error,
  impact,
  children,
  onConfirm,
  onCancel,
}: TypedNameConfirmProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const matches = typed === name;

  function submit() {
    if (!matches || busy) return;
    onConfirm();
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      title={title}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={submit} disabled={!matches || busy}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-details-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {children}
        {impact}
        <div className="space-details-field">
          <label className="space-details-label" htmlFor={inputId}>
            Type the {nameLabel} <code>{name}</code> to confirm
          </label>
          <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
        </div>
        {error && <p className="ui-form-error">{error}</p>}
      </form>
    </Modal>
  );
}
