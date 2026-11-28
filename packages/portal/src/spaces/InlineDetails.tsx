import { useRef, useState, type KeyboardEvent } from "react";
import { Input } from "../components/ui/Input";
import { PencilIcon } from "../components/ui/Icons";
import { SpaceApiError, updateSpaceDetails } from "../spaces-api";
import { DESCRIPTION_MAX, TITLE_MAX } from "./limits";

export type DetailsSaved = { title: string; description: string | null; updatedAt: number };

interface Current {
  name: string;
  title: string;
  description: string | null;
}

/** Saves the owner's title and description, one request at a time, and keeps the busy flag and the error for the modal to show. */
export function useDetailsSave(space: Current, onSaved: (saved: DetailsSaved) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function save(change: { title: string; description: string }): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateSpaceDetails(space.name, change));
      return true;
    } catch (e) {
      setError(
        e instanceof SpaceApiError && e.code === "CONFLICT"
          ? "This Space changed while you were editing. Close this and try again."
          : e instanceof SpaceApiError && e.message
            ? e.message
            : "Could not save. Try again."
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { busy, error, setError, save };
}

export type DetailsSave = ReturnType<typeof useDetailsSave>;

interface FieldProps {
  space: Current;
  /** Only the owner edits; anyone else sees plain text. */
  editable: boolean;
  details: DetailsSave;
}

/** The title. Click to edit in place: Enter or leaving the field saves, Escape puts it back. */
export function EditableTitle({ space, editable, details }: FieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);

  if (!editable) return <h2 className="space-detail-hero-title">{space.title}</h2>;

  async function commit() {
    if (done.current) return;
    const next = draft.trim();
    if (next === space.title) {
      done.current = true;
      details.setError(null);
      setEditing(false);
      return;
    }
    if (next.length === 0) {
      details.setError("The title cannot be empty.");
      return;
    }
    if (next.length > TITLE_MAX) {
      details.setError(`The title can be at most ${TITLE_MAX} characters.`);
      return;
    }
    const ok = await details.save({ title: next, description: space.description ?? "" });
    if (ok) {
      done.current = true;
      setEditing(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      // Cancels the edit, not the modal.
      e.stopPropagation();
      done.current = true;
      details.setError(null);
      setEditing(false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    }
  }

  if (editing) {
    return (
      <h2 className="space-detail-hero-title">
        <Input
          className="space-detail-title-input"
          aria-label="Title"
          value={draft}
          maxLength={TITLE_MAX + 40}
          state={draft.trim().length > TITLE_MAX ? "error" : "default"}
          disabled={details.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
          autoFocus
        />
      </h2>
    );
  }
  return (
    <h2 className="space-detail-hero-title">
      <button
        type="button"
        className="space-detail-edit-target space-detail-edit-title"
        aria-label="Edit title"
        onClick={() => {
          done.current = false;
          setDraft(space.title);
          details.setError(null);
          setEditing(true);
        }}
      >
        <span>{space.title}</span>
        <PencilIcon />
      </button>
    </h2>
  );
}

/** The description. Click to edit in place: leaving the field or Cmd/Ctrl+Enter saves, Escape puts it back. */
export function EditableDescription({ space, editable, details }: FieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false);

  if (!editable) return space.description ? <p className="space-detail-desc">{space.description}</p> : null;

  async function commit() {
    if (done.current) return;
    const next = draft.trim();
    if (next === (space.description ?? "")) {
      done.current = true;
      details.setError(null);
      setEditing(false);
      return;
    }
    if (next.length > DESCRIPTION_MAX) {
      details.setError(`The description can be at most ${DESCRIPTION_MAX} characters.`);
      return;
    }
    const ok = await details.save({ title: space.title, description: next });
    if (ok) {
      done.current = true;
      setEditing(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      done.current = true;
      details.setError(null);
      setEditing(false);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  }

  if (editing) {
    return (
      <div className="space-detail-desc-edit">
        <textarea
          className="ui-input space-details-textarea"
          aria-label="Description"
          rows={4}
          value={draft}
          disabled={details.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void commit()}
          autoFocus
        />
        <span className={`space-details-count${draft.length > DESCRIPTION_MAX ? " is-over" : ""}`}>
          {details.busy ? "Saving..." : `${draft.length}/${DESCRIPTION_MAX}`}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`space-detail-edit-target space-detail-edit-desc${space.description ? "" : " is-empty"}`}
      aria-label="Edit description"
      onClick={() => {
        done.current = false;
        setDraft(space.description ?? "");
        details.setError(null);
        setEditing(true);
      }}
    >
      <span className="space-detail-desc-text">{space.description || "Add a description"}</span>
      <PencilIcon />
    </button>
  );
}
