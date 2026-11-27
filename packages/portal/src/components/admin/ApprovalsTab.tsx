import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveAdminApproval,
  fetchAdminApprovals,
  rejectAdminApproval,
  type AdminApproval,
  type AdminApprovalPage,
} from "../../approvals-api";
import { ApprovalRow } from "../approvals/ApprovalRow";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

export const APPROVALS_KEY = ["admin", "approvals"] as const;
const PAGE = 25;

/** The open-request count for the tab badge. Silent on failure: the badge is a hint, not the page. */
export function usePendingAccountRequests(): number | undefined {
  const { data } = useQuery({
    queryKey: [...APPROVALS_KEY, "first"],
    queryFn: () => fetchAdminApprovals({ limit: PAGE }),
    staleTime: ADMIN_STALE_MS,
    retry: false,
  });
  return data?.pending_total;
}

type Decision = { kind: "approve" | "reject"; item: AdminApproval; note?: string };

export default function ApprovalsTab() {
  const qc = useQueryClient();
  const first = useQuery({
    queryKey: [...APPROVALS_KEY, "first"],
    queryFn: () => fetchAdminApprovals({ limit: PAGE }),
    staleTime: ADMIN_STALE_MS,
  });
  const [more, setMore] = useState<AdminApproval[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // The cursor from the newest page wins; before "load more" it is the first page's.
  const nextCursor = cursor === undefined ? (first.data?.next_cursor ?? null) : cursor;
  const items = [...(first.data?.items ?? []), ...more].filter((i) => !gone.has(i.id));
  const total = Math.max(0, (first.data?.pending_total ?? 0) - gone.size);

  const decide = useMutation({
    mutationFn: ({ kind, item, note }: Decision) =>
      kind === "approve" ? approveAdminApproval(item.id) : rejectAdminApproval(item.id, note),
    onSuccess: (_r, { item }) => {
      setError(null);
      setGone((g) => new Set(g).add(item.id));
      // New users count, and the Users list changes with the decision.
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Action failed"),
  });

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page: AdminApprovalPage = await fetchAdminApprovals({ limit: PAGE, cursor: nextCursor });
      setMore((m) => [...m, ...page.items]);
      setCursor(page.next_cursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load more");
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      {error && <div className="ui-form-error" role="alert">{error}</div>}
      <Box
        title={
          <>
            Approvals
            {total > 0 && (
              <span className="ui-tab-count" aria-label={`${total} waiting`}>
                {total}
              </span>
            )}
          </>
        }
      >
        <CardBody isLoading={first.isLoading} isError={first.isError} label="approvals">
          <p className="wb-approval-intro">
            New accounts wait here until an admin approves them. Reject declines this request and the person can ask
            again later. Disable on the Users tab is the permanent no.
          </p>
          {total > 0 && (
            <p className="wb-approval-banner" role="status">
              {total} {total === 1 ? "account is" : "accounts are"} waiting for approval.
            </p>
          )}
          {items.length === 0 ? (
            <EmptyState message="No account requests are waiting." />
          ) : (
            <ul className="wb-approval-list" aria-label="Account requests">
              {items.map((item) => (
                <ApprovalRow
                  key={item.id}
                  who={item.requester_email}
                  createdAt={item.created_at}
                  message={item.message}
                  busy={decide.isPending}
                  onApprove={() => decide.mutate({ kind: "approve", item })}
                  onReject={(note) => decide.mutate({ kind: "reject", item, note })}
                />
              ))}
            </ul>
          )}
          {nextCursor && (
            <div className="wb-approval-more">
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </CardBody>
      </Box>
    </>
  );
}
