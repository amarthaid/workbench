import { useId, useState, type ReactNode } from "react";
import { DECISION_NOTE_MAX } from "../../approvals-api";
import { shortDate } from "../../format";
import { Button } from "../ui/Button";

export const DELEGATED_WARNING = "This Space runs with your connected apps. Approving lets this person use them.";

export interface ApprovalRowProps {
  /** Who is asking. Text only. */
  who: string;
  /** What they ask for, when the list mixes Spaces. */
  what?: ReactNode;
  /** Unix seconds. */
  createdAt: number;
  /** Text the requester wrote. Rendered as text, never as markup. */
  message: string | null;
  /** Shown before the buttons, e.g. the delegated-access warning. */
  warning?: string;
  approveLabel?: string;
  busy?: boolean;
  onApprove: () => void;
  onReject: (note: string) => void;
}

/**
 * One request with its two decisions. Approve is one click. Reject opens an
 * optional note first, so a mis-click does not send one, and Cancel puts the
 * row back.
 */
export function ApprovalRow({
  who,
  what,
  createdAt,
  message,
  warning,
  approveLabel = "Approve",
  busy = false,
  onApprove,
  onReject,
}: ApprovalRowProps) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  const warnId = useId();

  return (
    <li className="wb-approval">
      <div className="wb-approval-head">
        <span className="wb-approval-who">{who}</span>
        <span className="wb-approval-date">{shortDate(createdAt)}</span>
      </div>
      {what && <div className="wb-approval-what">{what}</div>}
      {message ? (
        <p className="wb-approval-message">{message}</p>
      ) : (
        <p className="wb-approval-message wb-approval-empty">No message.</p>
      )}
      {warning && (
        <p className="wb-approval-warn" id={warnId}>
          {warning}
        </p>
      )}
      {rejecting ? (
        <div className="wb-approval-note">
          <label className="ui-field-label" htmlFor={noteId}>
            Note for {who} (optional)
          </label>
          <input
            id={noteId}
            type="text"
            className="ui-input"
            maxLength={DECISION_NOTE_MAX}
            value={note}
            autoFocus
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onReject(note);
              }
            }}
          />
          <div className="wb-approval-actions">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" disabled={busy} aria-label={`Send rejection to ${who}`} onClick={() => onReject(note)}>
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="wb-approval-actions">
          <Button variant="outline" size="sm" disabled={busy} aria-label={`Reject ${who}`} onClick={() => setRejecting(true)}>
            Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            aria-label={`${approveLabel} ${who}`}
            aria-describedby={warning ? warnId : undefined}
            onClick={onApprove}
          >
            {approveLabel}
          </Button>
        </div>
      )}
    </li>
  );
}
