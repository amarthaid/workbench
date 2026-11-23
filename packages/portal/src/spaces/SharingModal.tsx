import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { SpaceApiError, updateSpaceSharing, type SpaceSharing, type SpaceVisibility } from "../spaces-api";

const EMAIL = /^[^\s@]+@[^\s@]+$/;

const CHOICES: { value: SpaceVisibility; label: string; hint: string }[] = [
  { value: "private", label: "Only me", hint: "Nobody else can open it." },
  { value: "org", label: "Everyone signed in", hint: "Anyone who can sign in to this workbench can open it." },
  { value: "users", label: "Specific people", hint: "Only the people listed below can open it." },
];

/** Split pasted text on commas, semicolons and whitespace into lowercased, de-duplicated entries. */
export function splitEmails(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export function SharingModal({
  open,
  spaceName,
  visibility,
  users,
  onClose,
  onSaved,
}: {
  open: boolean;
  spaceName: string;
  visibility: SpaceVisibility;
  users: string[];
  onClose: () => void;
  onSaved: (sharing: SpaceSharing) => void;
}) {
  const [choice, setChoice] = useState<SpaceVisibility>(visibility);
  const [list, setList] = useState<string[]>(users);
  const [draft, setDraft] = useState("");
  // Addresses typed or pasted but not yet added to the list, shown as pills.
  const [pills, setPills] = useState<string[]>([]);
  const draftRef = useRef<HTMLInputElement>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Start from the saved settings each time the dialog opens, and only then:
  // the parent passes a fresh `users` array on every render, so depending on it
  // would wipe the owner's unsaved edits whenever the page re-renders.
  useEffect(() => {
    if (!open) return;
    setChoice(visibility);
    setList(users);
    setDraft("");
    setPills([]);
    setInputError(null);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Turn text into pills. Everything before the last separator becomes a pill;
  // the remainder stays in the box unless `all` (Enter, Add, blur).
  const pillify = (text: string, all: boolean): string => {
    const parts = text.split(/[,;\s]+/);
    const rest = all ? "" : (parts.pop() ?? "");
    const fresh = parts.map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (fresh.length) setPills((prev) => Array.from(new Set([...prev, ...fresh])));
    return rest;
  };

  const add = () => {
    const leftover = pillify(draft, true);
    setDraft(leftover);
    // Read the pills including what pillify just queued.
    const entries = Array.from(new Set([...pills, ...splitEmails(draft)]));
    if (entries.length === 0) return;
    const bad = entries.filter((e) => !EMAIL.test(e));
    if (bad.length > 0) {
      setPills(entries);
      setInputError(`Not an email address: ${bad.join(", ")}. Remove it to continue.`);
      return;
    }
    setList((prev) => Array.from(new Set([...prev, ...entries])).sort());
    setPills([]);
    setInputError(null);
    draftRef.current?.focus();
  };

  const dropPill = (email: string) => {
    setPills((prev) => {
      const next = prev.filter((p) => p !== email);
      if (!next.some((p) => !EMAIL.test(p))) setInputError(null);
      return next;
    });
  };

  const remove = (email: string) => setList((prev) => prev.filter((e) => e !== email));

  const save = async () => {
    if (choice === "users" && (pills.length > 0 || draft.trim() !== "")) {
      setSaveError("Press Add to include the addresses you typed, or clear them.");
      return;
    }
    if (choice === "users" && list.length === 0) {
      setSaveError("Add at least one person, or choose another option.");
      return;
    }
    const before = new Set(users);
    const after = new Set(list);
    const add_users = list.filter((e) => !before.has(e));
    const remove_users = users.filter((e) => !after.has(e));
    setBusy(true);
    setSaveError(null);
    try {
      const saved = await updateSpaceSharing(spaceName, {
        ...(choice !== visibility ? { visibility: choice } : {}),
        ...(add_users.length ? { add_users } : {}),
        ...(remove_users.length ? { remove_users } : {}),
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      setSaveError(e instanceof SpaceApiError ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Sharing"
      size="lg"
      className="space-share-modal"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy ? "Saving..." : "Save"}</Button>
        </>
      }
    >
      <fieldset className="ui-field space-share-choices" disabled={busy}>
        <legend className="ui-field-label">Who can open this Space</legend>
        {CHOICES.map((c) => (
          <label key={c.value} className="space-share-choice">
            <input
              type="radio"
              name="space-visibility"
              value={c.value}
              checked={choice === c.value}
              onChange={() => setChoice(c.value)}
            />
            <span>
              <span className="space-share-choice-label">{c.label}</span>
              <span className="space-muted">{c.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {choice === "users" && (
        <div className="ui-field space-share-people">
          <span className="ui-field-label">People{list.length ? ` (${list.length})` : ""}</span>
          {list.length === 0 ? (
            <p className="space-muted">Nobody yet.</p>
          ) : (
            <ul className="space-share-list" aria-label="People with access">
              {list.map((email) => (
                <li key={email} className="space-share-row">
                  <span className="space-share-email">{email}</span>
                  <Button variant="ghost" size="xs" onClick={() => remove(email)} disabled={busy} aria-label={`Remove ${email}`}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-share-add">
            <div
              className={`ui-input space-share-pills${inputError ? " ui-input-error" : ""}`}
              onClick={() => draftRef.current?.focus()}
            >
              {pills.map((p) => {
                const valid = EMAIL.test(p);
                return (
                  <span key={p} className={`space-share-pill${valid ? "" : " space-share-pill-bad"}`} title={valid ? undefined : "Not an email address"}>
                    {p}
                    <button
                      type="button"
                      className="space-share-pill-x"
                      aria-label={`Remove ${p} from the addresses to add`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        dropPill(p);
                      }}
                    >
                      x
                    </button>
                  </span>
                );
              })}
              <input
                ref={draftRef}
                type="text"
                inputMode="email"
                className="space-share-pills-input"
                placeholder={pills.length ? "" : "name@example.com, another@example.com"}
                aria-label="Email addresses to add"
                value={draft}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  setInputError(null);
                  setDraft(/[,;\s]/.test(v) ? pillify(v, false) : v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  } else if (e.key === "Backspace" && draft === "" && pills.length) {
                    dropPill(pills[pills.length - 1]);
                  }
                }}
                onBlur={() => setDraft((d) => pillify(d, true))}
              />
            </div>
            <Button variant="outline" onClick={add} disabled={busy || (pills.length === 0 && draft.trim() === "")}>Add</Button>
          </div>
          <span className="space-muted">Type a comma after each address to make a pill, then press Add. People need a workbench sign-in.</span>
          {inputError && <div className="ui-form-error">{inputError}</div>}
        </div>
      )}

      {saveError && <div className="ui-form-error">{saveError}</div>}
    </Modal>
  );
}
