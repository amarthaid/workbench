import { useId, useState } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { SpaceApiError, deleteSpace, type SpaceVisibility } from "../spaces-api";

interface Props {
  space: { name: string; title: string; visibility: SpaceVisibility };
  /** How many people it is shared with, when known (Specific people). */
  sharedWith?: number;
  /** People who opened it in the last 30 days. Absent means do not show. */
  openers?: number;
  onClose: () => void;
  /** The Space is gone. The caller closes the detail and drops it from the list. */
  onDeleted: (name: string) => void;
}

export function audienceLabel(visibility: SpaceVisibility, sharedWith?: number): string {
  if (visibility === "org") return "Everyone signed in";
  if (visibility === "users") return sharedWith === undefined ? "Specific people" : `Specific people (${sharedWith})`;
  return "Only me";
}

export function openersLine(openers: number | undefined): string | null {
  if (openers === undefined) return null;
  return `${openers} ${openers === 1 ? "person" : "people"} opened it in the last 30 days`;
}

/** Owner only. The red button stays off until the Space's name is typed exactly. */
export function DeleteSpaceDialog({ space, sharedWith, openers, onClose, onDeleted }: Props) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const opened = openersLine(openers);

  async function confirm() {
    if (typed !== space.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteSpace(space.name);
      onDeleted(space.name);
    } catch (e) {
      setError(e instanceof SpaceApiError && e.message ? e.message : "Could not delete the Space. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={`Delete ${space.title}?`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} disabled={typed !== space.name || busy}>
            {busy ? "Deleting..." : "Delete Space"}
          </Button>
        </>
      }
    >
      <form
        className="space-details-form"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p>
          This deletes <strong>{space.title}</strong> and cannot be undone.
        </p>
        <ul className="space-delete-impact">
          <li>Who can open it now: {audienceLabel(space.visibility, sharedWith)}</li>
          {opened && <li>{opened}</li>}
          <li>All files and data stored in the Space go with it.</li>
          <li>People who have it open will lose it.</li>
        </ul>
        <div className="space-details-field">
          <label className="space-details-label" htmlFor={inputId}>
            Type the Space name <code>{space.name}</code> to confirm
          </label>
          <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
        </div>
        {error && <p className="ui-form-error">{error}</p>}
      </form>
    </Modal>
  );
}
