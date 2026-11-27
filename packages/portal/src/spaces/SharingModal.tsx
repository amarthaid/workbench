import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Modal } from "../components/ui/Modal";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Switch";
import { Badge } from "../components/ui/Badge";
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
const WIDEN = "Everyone signed in will be able to use your access.";

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

interface SharingProps {
  open: boolean;
  /** Which Space; it is read again on open, so a name is all that is needed. */
  space: Pick<SpaceDetail, "name">;
  onClose: () => void;
  onSaved: (sharing: SpaceSharing) => void;
}

/**
 * Reads the Space again each time it opens, so the tool list, its hash and
 * the paused state are never the page's possibly stale copy: the owner must
 * confirm exactly the list the server holds.
 */
export function SharingModal({ open, space, onClose, onSaved }: SharingProps) {
  const [fresh, setFresh] = useState<SpaceDetail | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!open) {
      // Drop the copy on close, so a reopen never shows it for a frame
      // before the new read lands.
      setFresh(null);
      return;
    }
    let live = true;
    setFresh(null);
    setLoadError(false);
    fetchSpace(space.name)
      .then((d) => live && setFresh(d))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  if (!fresh) {
    return (
      <Modal open onClose={onClose} title="Sharing" size="lg" className="space-share-modal">
        {loadError ? (
          <div className="ui-form-error">Could not load the sharing settings. Close and try again.</div>
        ) : (
          <div className="ui-loading">Loading sharing settings...</div>
        )}
      </Modal>
    );
  }
  return <SharingForm space={fresh} onClose={onClose} onSaved={onSaved} />;
}

type TabId = "access" | "people";

/** Everything the two tabs share: the form's state and what it derives from it. */
interface FormModel {
  space: SpaceDetail;
  latest: SpaceDetail;
  busy: boolean;
  visibility: SpaceVisibility;
  choice: SpaceVisibility;
  chooseAudience: (v: SpaceVisibility) => void;
  list: string[];
  remove: (email: string) => void;
  draft: string;
  setDraft: (v: string) => void;
  pills: string[];
  pillify: (text: string, all: boolean) => string;
  add: () => void;
  dropPill: (email: string) => void;
  draftRef: React.RefObject<HTMLInputElement | null>;
  inputError: string | null;
  setInputError: (v: string | null) => void;
  delegate: boolean;
  setDelegate: (on: boolean) => void;
  wasOn: boolean;
  canDelegate: boolean;
  isPrivate: boolean;
  suspended: boolean;
  widening: boolean;
  widenBlocked: boolean;
  notice: string | null;
  setNotice: (v: string | null) => void;
  goTo: (tab: TabId) => void;
  confirmTools: () => void;
}

function SharingForm({ space, onClose, onSaved }: Omit<SharingProps, "open" | "space"> & { space: SpaceDetail }) {
  const open = true;
  const visibility = space.visibility;
  const users = space.users ?? [];
  // The stored setting, as the server holds it: the dialog reads, widens and
  // turns off against this, never against what is in effect.
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
  const [tab, setTab] = useState<TabId>("access");

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

  // Without the permission (the server says so with delegation_blocked, an
  // older one with can_delegate) there is no Access tab: the dialog is the
  // People content alone, plus a way to turn a stored "on" off.
  const canDelegate = latest.can_delegate === true && latest.delegation_blocked !== "no_permission";
  const isPrivate = choice === "private";
  const suspended = wasOn && latest.delegation_suspended === true;
  // Opening a delegated Space to everyone signed in lends the access to more
  // people: the same review as turning it on. Narrowing needs nothing.
  const widening = wasOn && delegate && visibility !== "org" && choice === "org";
  // Turning it on, or widening it, needs the second step; resuming a paused
  // one goes through "Confirm tools".
  const needsConfirm = delegate && (!wasOn || widening);
  // Widening needs the permission the server checks on confirm; without it the
  // confirm would only be refused, so it is not offered.
  const widenBlocked = widening && !canDelegate;
  const leadsToConfirm = needsConfirm && !widenBlocked;

  const chooseAudience = (v: SpaceVisibility) => {
    setChoice(v);
    // Only me cannot be delegated: the server resets it, so the switch does too.
    if (v === "private") setDelegate(false);
  };

  const submit = async (confirmDelegation: boolean) => {
    if (confirmDelegation && !latest.tools_hash) {
      // Never confirm a list without its hash: the server would refuse it, and
      // an empty hash must not be what is sent.
      setSaveError("Reload this Space and try again.");
      return;
    }
    const before = new Set(users);
    const after = new Set(list);
    const add_users = list.filter((e) => !before.has(e));
    const remove_users = users.filter((e) => !after.has(e));
    const change: SpaceSharingChange = {
      ...(choice !== visibility ? { visibility: choice } : {}),
      ...(add_users.length ? { add_users } : {}),
      ...(remove_users.length ? { remove_users } : {}),
      ...(confirmDelegation
        ? { delegate_access: true, tools_hash: latest.tools_hash }
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
    if (widenBlocked) return;
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

  const model: FormModel = {
    space, latest, busy, visibility, choice, chooseAudience, list, remove, draft, setDraft, pills, pillify, add,
    dropPill, draftRef, inputError, setInputError, delegate, setDelegate, wasOn, canDelegate, isPrivate, suspended,
    widening, widenBlocked, notice, setNotice, goTo: setTab,
    confirmTools: () => {
      setSaveError(null);
      setStep("confirm");
    },
  };

  const tabs: { id: TabId; label: string; badge: ReactNode }[] = [
    { id: "access", label: "Access", badge: accessBadge(model) },
    { id: "people", label: "People", badge: peopleBadge(model) },
  ];
  const showTabs = canDelegate;
  const activeTab: TabId = showTabs ? tab : "people";

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
          <Button onClick={() => void save()} disabled={busy || widenBlocked}>
            {busy ? "Saving..." : leadsToConfirm ? "Review and delegate" : "Save"}
          </Button>
        </>
      }
    >
      {showTabs && <ShareTabs tabs={tabs} value={activeTab} onChange={setTab} />}
      {showTabs && (
        <div role="tabpanel" id="space-share-panel-access" aria-labelledby="space-share-tab-access" hidden={activeTab !== "access"}>
          <AccessTab m={model} />
        </div>
      )}
      <div
        role={showTabs ? "tabpanel" : undefined}
        id="space-share-panel-people"
        aria-labelledby={showTabs ? "space-share-tab-people" : undefined}
        hidden={activeTab !== "people"}
      >
        <PeopleTab m={model} />
      </div>

      {saveError && <div className="ui-form-error">{saveError}</div>}
    </Modal>
  );
}

function accessBadge(m: FormModel): ReactNode {
  if (m.delegate !== m.wasOn || m.widening) return <Badge variant="orange">Not saved</Badge>;
  if (!m.wasOn) return null;
  return m.suspended ? <Badge variant="orange">Paused</Badge> : <Badge variant="green">On</Badge>;
}

function peopleBadge(m: FormModel): ReactNode {
  if (m.choice === "private") return <Badge variant="neutral">Only me</Badge>;
  if (m.choice === "org") return <Badge variant={m.widening ? "orange" : "neutral"}>Everyone</Badge>;
  return <Badge variant="neutral">{m.list.length}</Badge>;
}

function ShareTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: TabId; label: string; badge: ReactNode }[];
  value: TabId;
  onChange: (id: TabId) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  };
  return (
    <div className="ui-tabs space-share-tabs" role="tablist" aria-label="Sharing sections" onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`space-share-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`space-share-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            className={`ui-tab${selected ? " ui-tab-active" : ""}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge}
          </button>
        );
      })}
    </div>
  );
}

function AccessTab({ m }: { m: FormModel }) {
  const { latest, delegate, wasOn, suspended, widening, isPrivate, busy } = m;
  const apps = new Set(latest.tools.map((t) => t.integration)).size;
  const count = latest.tools.length;
  const audience =
    m.choice === "org"
      ? "Everyone signed in"
      : `${m.list.length} ${m.list.length === 1 ? "person" : "people"}`;
  const reviewing = delegate && !m.widenBlocked && (!wasOn || (widening && !suspended));

  return (
    <>
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
        </span>
        <Switch
          checked={delegate}
          onChange={(on) => {
            m.setDelegate(on);
            m.setNotice(null);
          }}
          disabled={busy || isPrivate}
          aria-labelledby="space-delegate-label"
          aria-describedby="space-delegate-hint"
        />
      </div>

      {isPrivate && (
        <div className="space-share-note">
          <span className="space-share-choice-label">This Space is private</span>
          <span className="space-muted">
            Only you can open it, so there is nobody to lend access to.{" "}
            <button type="button" className="space-share-link" onClick={() => m.goTo("people")}>
              Choose who can open it
            </button>
          </span>
        </div>
      )}

      {!isPrivate && !delegate && (
        <div className="space-share-note is-dashed">
          <span className="space-share-choice-label">Viewers use their own access</span>
          <span className="space-muted">
            Each person connects their own apps. Turning this on would lend {count} {count === 1 ? "tool" : "tools"}{" "}
            across {apps} {apps === 1 ? "app" : "apps"}.
          </span>
        </div>
      )}

      {reviewing && (
        <>
          <div className="space-share-status">
            <Badge variant="orange">Not saved</Badge>
            <span>{audience} will be able to use your access</span>
          </div>
          <div className="space-warn-box" role="note">
            <p className="space-warn-title">{LENT}</p>
            {widening && <p className="space-warn-text"><strong>{WIDEN}</strong></p>}
            {m.notice && <p className="space-warn-text"><strong>{m.notice}</strong></p>}
            <p className="space-warn-text">
              This is every tool the Space declares, reads included. The Space's page does not limit what a viewer can
              send. Save to review and confirm.
            </p>
            <SpaceToolList tools={latest.tools} delegation />
          </div>
        </>
      )}

      {delegate && wasOn && !suspended && !widening && (
        <>
          <div className="space-share-status">
            <Badge variant="green">Active</Badge>
            <span>{audience} can use your access</span>
          </div>
          <div className="space-share-note">
            <span className="space-share-choice-label">
              Lends {count} {count === 1 ? "tool" : "tools"} across {apps} {apps === 1 ? "app" : "apps"}, with any input
            </span>
            <SpaceToolList tools={latest.tools} delegation />
          </div>
        </>
      )}

      {delegate && suspended && (
        <>
          <div className="space-share-status">
            <Badge variant="orange">Paused</Badge>
            <span>Viewers cannot use this Space until you confirm</span>
          </div>
          <div className="space-warn-box" role="note">
            <p className="space-warn-title">The tool list changed. Review and confirm to resume.</p>
            {m.notice && <p className="space-warn-text"><strong>{m.notice}</strong></p>}
            <p className="space-warn-text">Delegation is paused. {LENT}</p>
            {widening && <p className="space-warn-text"><strong>{WIDEN}</strong></p>}
            <SpaceToolList tools={latest.tools} delegation />
            <div className="space-warn-actions">
              <Button variant="danger" size="sm" disabled={busy || isPrivate || !m.canDelegate} onClick={m.confirmTools}>
                Confirm tools
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PeopleTab({ m }: { m: FormModel }) {
  const { busy, list, pills, draft, inputError } = m;
  return (
    <>
      {m.wasOn && !m.canDelegate && (
        <div className="space-share-note">
          <span className="space-muted">
            {m.delegate
              ? "Delegated access is off because an admin removed your permission. Turn it off to clear the setting."
              : "Delegated access will be cleared when you save."}
          </span>
          {m.delegate && (
            <Button variant="outline" size="xs" disabled={busy} onClick={() => m.setDelegate(false)}>
              Turn off
            </Button>
          )}
        </div>
      )}
      {m.widenBlocked && (
        <p className="ui-form-error" role="alert">
          Turn off Delegate my access to change who can open this Space, or ask an admin to allow it again.
        </p>
      )}

      <fieldset className="ui-field space-share-choices" disabled={busy}>
        <legend className="ui-field-label">Who can open this Space</legend>
        {CHOICES.map((c) => {
          return (
            <label key={c.value} className="space-share-choice">
              <input
                type="radio"
                name="space-visibility"
                value={c.value}
                checked={m.choice === c.value}
                onChange={() => m.chooseAudience(c.value)}
              />
              <span>
                <span className="space-share-choice-label">{c.label}</span>
                <span className="space-muted">{c.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {m.choice === "users" && (
        <div className="ui-field space-share-people">
          <span className="ui-field-label">People{list.length ? ` (${list.length})` : ""}</span>
          {list.length === 0 ? (
            <p className="space-muted">Nobody yet.</p>
          ) : (
            <ul className="space-share-list" aria-label="People with access">
              {list.map((email) => (
                <li key={email} className="space-share-row">
                  <span className="space-share-email">{email}</span>
                  <Button variant="ghost" size="xs" onClick={() => m.remove(email)} disabled={busy} aria-label={`Remove ${email}`}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="space-share-add">
            <div
              className={`ui-input space-share-pills${inputError ? " ui-input-error" : ""}`}
              onClick={() => m.draftRef.current?.focus()}
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
                        m.dropPill(p);
                      }}
                    >
                      x
                    </button>
                  </span>
                );
              })}
              <input
                ref={m.draftRef}
                type="text"
                inputMode="email"
                className="space-share-pills-input"
                placeholder={pills.length ? "" : "name@example.com, another@example.com"}
                aria-label="Email addresses to add"
                value={draft}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value;
                  m.setInputError(null);
                  m.setDraft(/[,;\s]/.test(v) ? m.pillify(v, false) : v);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    m.add();
                  } else if (e.key === "Backspace" && draft === "" && pills.length) {
                    m.dropPill(pills[pills.length - 1]);
                  }
                }}
                onBlur={() => m.setDraft(m.pillify(draft, true))}
              />
            </div>
            <Button variant="outline" onClick={m.add} disabled={busy || (pills.length === 0 && draft.trim() === "")}>Add</Button>
          </div>
          <span className="space-muted">Type a comma after each address to make a pill, then press Add. People need a workbench sign-in.</span>
          {inputError && <div className="ui-form-error">{inputError}</div>}
        </div>
      )}
    </>
  );
}
