import { useId, useState } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { SpaceApiError, updateSpaceDetails } from "../spaces-api";

export const TITLE_MAX = 120;
export const DESCRIPTION_MAX = 1000;

interface Props {
  open: boolean;
  space: { name: string; title: string; description: string | null };
  onClose: () => void;
  onSaved: (saved: { title: string; description: string | null; updatedAt: number }) => void;
}

/**
 * The owner's title and description, edited without opening the Space. The tool
 * list is deliberately not here: changing it asks every viewer to approve again,
 * which only an agent's update_space does.
 */
export function EditDetailsModal({ open, space, onClose, onSaved }: Props) {
  if (!open) return null;
  return <Form space={space} onClose={onClose} onSaved={onSaved} />;
}

function Form({ space, onClose, onSaved }: Omit<Props, "open">) {
  const [title, setTitle] = useState(space.title);
  const [description, setDescription] = useState(space.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const trimmed = title.trim();
  const changed = trimmed !== space.title || description.trim() !== (space.description ?? "");
  const valid = trimmed.length > 0 && trimmed.length <= TITLE_MAX && description.length <= DESCRIPTION_MAX;

  async function save() {
    if (!valid || !changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await updateSpaceDetails(space.name, { title: trimmed, description: description.trim() });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(
        e instanceof SpaceApiError && e.code === "CONFLICT"
          ? "This Space changed while you were editing. Close this and try again."
          : e instanceof SpaceApiError && e.message
            ? e.message
            : "Could not save. Try again."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Edit details"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid || !changed || busy}>
            {busy ? "Saving..." : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="space-details-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-details-field">
          <label className="space-details-label" htmlFor={titleId}>
            Title
          </label>
          <Input
            id={titleId}
            value={title}
            maxLength={TITLE_MAX + 40}
            state={trimmed.length > TITLE_MAX ? "error" : "default"}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-details-field">
          <label className="space-details-label" htmlFor={descriptionId}>
            Description
          </label>
          <textarea
            id={descriptionId}
            className="ui-input space-details-textarea"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <span className={`space-details-count${description.length > DESCRIPTION_MAX ? " is-over" : ""}`}>
            {description.length}/{DESCRIPTION_MAX}
          </span>
        </div>
        <p className="space-muted">
          What it can do (its tools) is set by the agent that built it. If an agent deploys this Space again, it sets the title
          and description again.
        </p>
        {error && <p className="ui-form-error">{error}</p>}
      </form>
    </Modal>
  );
}
