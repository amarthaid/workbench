import { useId, useState } from "react";
import { REQUEST_MESSAGE_MAX, requestSpaceAccess } from "../approvals-api";
import { Button } from "../components/ui/Button";

/**
 * The server answers a request the same way whether or not the Space exists,
 * so this copy is fixed and never says the Space is real.
 */
export const ASKED_COPY =
  "If this Space exists and was shared with specific people, the owner has been asked. You will see it in your gallery once approved.";

const KEY_PREFIX = "wb_space_access_asked:";

function wasAsked(name: string): boolean {
  try {
    return localStorage.getItem(KEY_PREFIX + name) !== null;
  } catch {
    return false;
  }
}

function remember(name: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY_PREFIX + name, String(Date.now()));
    else localStorage.removeItem(KEY_PREFIX + name);
  } catch {
    // Storage can be unavailable; the waiting copy still shows for this visit.
  }
}

/**
 * Shown where a Space could not be opened. Sends an access request with an
 * optional message, then shows the fixed neutral copy, and remembers that per
 * Space name so a reload does not offer to ask again straight away.
 */
export function AskAccess({ name, children }: { name: string; children?: React.ReactNode }) {
  const [waiting, setWaiting] = useState(() => wasAsked(name));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestSpaceAccess(name, message);
      remember(name, true);
      setWaiting(true);
    } catch (e) {
      setError(e instanceof Error && e.message !== "Action failed" ? e.message : "Could not send the request. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (waiting) {
    return (
      <div className="space-ask">
        <p className="space-muted" role="status">{ASKED_COPY}</p>
        <div className="space-consent-actions">
          {children}
          <Button
            variant="outline"
            onClick={() => {
              remember(name, false);
              setWaiting(false);
              setMessage("");
            }}
          >
            Ask again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-ask">
      <label className="ui-field-label" htmlFor={id}>
        Message for the owner (optional)
      </label>
      <textarea
        id={id}
        className="ui-input space-details-textarea"
        rows={3}
        maxLength={REQUEST_MESSAGE_MAX}
        value={message}
        disabled={busy}
        onChange={(e) => setMessage(e.target.value)}
      />
      <span className={`space-details-count${message.length >= REQUEST_MESSAGE_MAX ? " is-over" : ""}`}>
        {message.length}/{REQUEST_MESSAGE_MAX}
      </span>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      <div className="space-consent-actions">
        {children}
        <Button variant="primary" disabled={busy} onClick={() => void send()}>
          {busy ? "Sending..." : "Ask the owner for access"}
        </Button>
      </div>
    </div>
  );
}
