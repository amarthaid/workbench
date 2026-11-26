import { useEffect, useRef, useState } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import {
  DELEGATION_ERROR_CODES,
  SpaceApiError,
  fetchSpace,
  updateSpaceSharing,
  type SpaceDetail,
  type SpaceSharing,
  type SpaceSharingChange,
  type SpaceVisibility,
} from "../spaces-api";
import { SpaceToolList } from "./ToolList";

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

const LENT = "Viewers can call these with your access, with any input.";

/** Copy for a refused save. TOOLS_CHANGED is handled by the caller. */
function saveErrorMessage(e: unknown, choice: SpaceVisibility): string {
  if (!(e instanceof SpaceApiError)) return "Could not save. Try again.";
  if (e.code === DELEGATION_ERROR_CODES.NOT_ALLOWED) {
    return choice === "private"
      ? "Delegated access needs a Space shared with specific people or everyone signed in."
      : "An admin has not allowed you to delegate access. Ask an admin to allow it.";
  }
  if (e.code === "CONFLICT") return "This Space changed while you were editing. Try again.";
  return e.message;
}

export function SharingModal({
  open,
  space,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The owner's view of the Space. */
  space: SpaceDetail;
  onClose: () => void;
  onSaved: (sharing: SpaceSharing) => void;
}) {
  const visibility = space.visibility;
  const users = space.users ?? [];
  const wasOn = space.delegate_access === true;
  const [choice, setChoice] = useState<SpaceVisibility>(visibility);
  const [list, setList] = useState<string[]>(users);
  const [draft, setDraft] = useState("");
  // Addresses typed or pasted but not yet added to the list, shown as pills.
  const [pills, setPills] = useState<string[]>([]);
  const draftRef = useRef<HTMLInputElement>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delegate, setDelegate] = useState(wasOn);
  // The tool list the owner is reviewing: the Space as opened, or a fresh copy
  // after the server said the list changed (TOOLS_CHANGED).
  const [latest, setLatest] = useState<SpaceDetail>(space);
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [notice, setNotice] = useState<string | null>(null);

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
    setDelegate(wasOn);
    setLatest(space);
    setStep("edit");
    setNotice(null);
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

  const canDelegate = latest.can_delegate === true;
  // Shown with the permission, or while it is still on after a revoke so the
  // owner can turn it off.
  const showDelegate = canDelegate || wasOn;
  const isPrivate = choice === "private";
  const suspended = wasOn && latest.delegation_suspended === true;
  // Turning it on needs the second step; resuming a paused one goes through
  // "Confirm tools".
  const needsConfirm = delegate && !wasOn;

  const chooseAudience = (v: SpaceVisibility) => {
    setChoice(v);
    // Only me cannot be delegated: the server resets it, so the switch does too.
    if (v === "private") setDelegate(false);
  };

  const submit = async (confirmDelegation: boolean) => {
    const before = new Set(users);
    const after = new Set(list);
    const add_users = list.filter((e) => !before.has(e));
    const remove_users = users.filter((e) => !after.has(e));
    const change: SpaceSharingChange = {
      ...(choice !== visibility ? { visibility: choice } : {}),
      ...(add_users.length ? { add_users } : {}),
      ...(remove_users.length ? { remove_users } : {}),
      ...(confirmDelegation
        ? { delegate_access: true, tools_hash: latest.tools_hash ?? "" }
        : wasOn && !delegate
          ? { delegate_access: false }
          : {}),
    };
    setBusy(true);
    setSaveError(null);
    try {
      const saved = await updateSpaceSharing(space.name, change);
      onSaved(saved);
      onClose();
    } catch (e) {
      if (e instanceof SpaceApiError && e.code === DELEGATION_ERROR_CODES.TOOLS_CHANGED) {
        // Show the list as it is now and ask again: never confirm a list the
        // owner has not seen.
        try {
          setLatest(await fetchSpace(space.name));
          setNotice("The tool list changed while you were reviewing it. Review the new list, then save again.");
        } catch {
          setSaveError("The tool list changed. Close and open Sharing again to review it.");
        }
        setStep("edit");
      } else {
        setSaveError(saveErrorMessage(e, choice));
      }
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (choice === "users" && (pills.length > 0 || draft.trim() !== "")) {
      setSaveError("Press Add to include the addresses you typed, or clear them.");
      return;
    }
    if (choice === "users" && list.length === 0) {
      setSaveError("Add at least one person, or choose another option.");
      return;
    }
    if (needsConfirm) {
      setSaveError(null);
      setStep("confirm");
      return;
    }
    await submit(false);
  };

  if (step === "confirm") {
    const audience =
      choice === "org" ? (
        <>Everyone signed in who opens <strong>{space.title}</strong> will run its tools as you, with your connected apps.</>
      ) : (
        <>
          The {list.length === 1 ? "person" : `${list.length} people`} you shared <strong>{space.title}</strong> with will
          run its tools as you, with your connected apps.
        </>
      );
    return (
      <Modal
        open={open}
        onClose={busy ? () => undefined : onClose}
        title="Delegate your access?"
        size="lg"
        className="space-share-modal"
        footer={
          <>
            <Button variant="outline" onClick={() => setStep("edit")} disabled={busy}>Back</Button>
            <Button variant="danger" onClick={() => void submit(true)} disabled={busy}>
              {busy ? "Saving..." : "Delegate access"}
            </Button>
          </>
        }
      >
        <div className="space-delegate-confirm">
          <p>{audience}</p>
          <p className="space-warn-title">{LENT}</p>
          <SpaceToolList tools={latest.tools} delegation />
          <p className="space-muted">
            Every call is logged under both names. Changing the tool list pauses delegation until you confirm again.
          </p>
          {saveError && <div className="ui-form-error">{saveError}</div>}
        </div>
      </Modal>
    );
  }

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
              onChange={() => chooseAudience(c.value)}
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

      {showDelegate && (
        <div className="space-share-delegate">
          <div className="space-share-delegate-head">
            <span className="space-share-delegate-text">
              <span id="space-delegate-label" className={`space-share-choice-label${isPrivate ? " is-disabled" : ""}`}>
                Delegate my access
              </span>
              <span id="space-delegate-hint" className="space-muted">
                {isPrivate
                  ? "Share with specific people or everyone signed in to delegate access."
                  : "People who open this Space use your connected apps, not theirs. Every call is logged under both names."}
              </span>
              {!canDelegate && (
                <span className="space-muted">
                  An admin removed your permission to delegate access, so viewers cannot use it. You can still turn it off.
                </span>
              )}
            </span>
            <Switch
              checked={delegate}
              onChange={(on) => {
                setDelegate(on);
                setNotice(null);
              }}
              disabled={busy || isPrivate || (!canDelegate && !delegate)}
              aria-labelledby="space-delegate-label"
              aria-describedby="space-delegate-hint"
            />
          </div>

          {delegate && !wasOn && (
            <div className="space-warn-box" role="note">
              <p className="space-warn-title">{LENT}</p>
              {notice && <p className="space-warn-text"><strong>{notice}</strong></p>}
              <p className="space-warn-text">
                This is every tool the Space declares, reads included. The Space's page does not limit what a viewer can
                send. Save to review and confirm.
              </p>
              <SpaceToolList tools={latest.tools} delegation />
            </div>
          )}

          {delegate && suspended && (
            <div className="space-warn-box" role="note">
              <p className="space-warn-title">The tool list changed. Review and confirm to resume.</p>
              {notice && <p className="space-warn-text"><strong>{notice}</strong></p>}
              <p className="space-warn-text">Delegation is paused. {LENT}</p>
              <SpaceToolList tools={latest.tools} delegation />
              <div className="space-warn-actions">
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy || isPrivate || !canDelegate}
                  onClick={() => {
                    setSaveError(null);
                    setStep("confirm");
                  }}
                >
                  Confirm tools
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {saveError && <div className="ui-form-error">{saveError}</div>}
    </Modal>
  );
}
