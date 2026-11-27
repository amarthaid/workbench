import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchApprovals } from "../approvals-api";
import { Modal } from "../components/ui/Modal";
import { INBOX_KEY, SpaceRequestList } from "./SpaceRequestList";

/** Everyone asking to open one of your Spaces. */
export function RequestsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: INBOX_KEY,
    queryFn: () => fetchApprovals("inbox"),
    enabled: open,
    staleTime: 0,
  });
  return (
    <Modal open={open} onClose={onClose} title="Access requests" size="lg">
      {isLoading ? (
        <div className="ui-loading">Loading requests...</div>
      ) : isError ? (
        <div className="ui-form-error">Could not load requests. Close and try again.</div>
      ) : (
        <SpaceRequestList
          items={data ?? []}
          // The gallery's count and the inbox both change with a decision.
          onDecided={() => void qc.invalidateQueries({ queryKey: ["spaces"] })}
        />
      )}
    </Modal>
  );
}
