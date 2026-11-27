import { useEffect, useState } from "react";
import { approveApproval, fetchApprovals, rejectApproval, type SpaceApproval } from "../approvals-api";
import { ApprovalRow, DELEGATED_WARNING } from "../components/approvals/ApprovalRow";

export const INBOX_KEY = ["approvals", "inbox"] as const;

/**
 * Open access requests with Approve and Reject. Used by the gallery's Requests
 * list (every Space) and by one Space's sharing dialog (`showSpace` off, since
 * the dialog already names it). It holds its own request state and needs no
 * query client, so the sharing dialog keeps working wherever it is mounted.
 */
export function SpaceRequestList({
  items,
  showSpace = true,
  onDecided,
}: {
  items: SpaceApproval[];
  showSpace?: boolean;
  /** After a decision lands, e.g. to refresh the gallery counts. */
  onDecided?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const decide = async (id: string, kind: "approve" | "reject", note?: string) => {
    setBusy(true);
    try {
      if (kind === "approve") await approveApproval(id);
      else await rejectApproval(id, note);
      setError(null);
      setGone((g) => new Set(g).add(id));
      onDecided?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const rows = items.filter((i) => !gone.has(i.id));
  return (
    <>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      {rows.length === 0 ? (
        <p className="space-muted">No one is waiting for access.</p>
      ) : (
        <ul className="wb-approval-list" aria-label="Access requests">
          {rows.map((r) => (
            <ApprovalRow
              key={r.id}
              who={r.requester_email ?? "Someone"}
              what={showSpace ? <>Wants to open <strong>{r.subject_label || r.subject}</strong></> : undefined}
              createdAt={r.created_at}
              message={r.message}
              warning={r.delegated ? DELEGATED_WARNING : undefined}
              busy={busy}
              onApprove={() => void decide(r.id, "approve")}
              onReject={(note) => void decide(r.id, "reject", note)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The open requests for one Space, inside its sharing dialog. Renders nothing
 * while loading, on a failed load, or when nobody is waiting: the dialog is
 * about sharing, and this is only worth the space when there is something to do.
 */
export function OpenRequests({ spaceName, onDecided }: { spaceName: string; onDecided?: () => void }) {
  const [items, setItems] = useState<SpaceApproval[] | null>(null);

  useEffect(() => {
    let live = true;
    fetchApprovals("inbox")
      .then((all) => live && setItems(all.filter((a) => a.subject === spaceName && a.status === "pending")))
      .catch(() => live && setItems(null));
    return () => {
      live = false;
    };
  }, [spaceName]);

  if (!items || items.length === 0) return null;
  return (
    <section className="wb-approval-section" aria-label="Open requests for this Space">
      <h3 className="wb-approval-section-title">Requests to open this Space ({items.length})</h3>
      <SpaceRequestList items={items} showSpace={false} onDecided={onDecided} />
    </section>
  );
}
