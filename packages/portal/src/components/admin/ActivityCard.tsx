import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchAdminActivity,
  fetchIntegrations,
  UNSTORED_MESSAGE,
  type AdminActivityEvent,
  type IntegrationSummary,
} from "../../api";
import { dayLabel, timeLabel } from "../../format";
import { integrationLookup } from "../ActivityTable";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Input, Select } from "../ui/Input";
import { Tabs } from "../ui/Tabs";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";

const PAGE_SIZE = 50;

export default function ActivityCard() {
  const [status, setStatus] = useState<"all" | "error">("all");
  const [integration, setIntegration] = useState("all");
  // The email box is a draft until submitted, so typing does not refetch.
  const [emailDraft, setEmailDraft] = useState("");
  const [email, setEmail] = useState("");

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(status === "error" ? { status: "error" as const } : {}),
      ...(integration !== "all" ? { integration } : {}),
      ...(email ? { email } : {}),
    }),
    [status, integration, email]
  );

  const query = useInfiniteQuery({
    queryKey: ["admin", "activity", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchAdminActivity({ ...filters, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // A focus refetch of an infinite query re-requests every loaded page.
    staleTime: ADMIN_STALE_MS,
  });

  const { data: registry } = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const integrations = (registry?.integrations ?? []) as IntegrationSummary[];
  const appFor = useMemo(() => integrationLookup(integrations), [integrations]);

  const pages = query.data?.pages ?? [];
  const stored = pages[0]?.stored ?? true;
  // De-duplicate by id: a refetch of an earlier page racing a "Load more" can
  // otherwise land the same row twice.
  const events = useMemo(() => {
    const seen = new Set<number>();
    return pages.flatMap((p) => p.events).filter((e: AdminActivityEvent) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [pages]);

  return (
    <Box title="Activity">
      <div className="wb-page-toolbar">
        <Tabs
          label="Filter activity"
          value={status}
          onChange={(id) => setStatus(id as "all" | "error")}
          items={[{ id: "all", label: "All" }, { id: "error", label: "Errors" }]}
        />
        <div className="wb-toolbar-controls">
          <label className="ui-sr-only" htmlFor="admin-activity-integration">Integration</label>
          <Select
            id="admin-activity-integration"
            value={integration}
            onChange={(e) => setIntegration(e.target.value)}
          >
            <option value="all">All apps</option>
            {integrations.map((i) => (
              <option key={i.name} value={i.name}>{i.displayName || i.name}</option>
            ))}
          </Select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEmail(emailDraft.trim());
            }}
          >
            <label className="ui-sr-only" htmlFor="admin-activity-email">User email</label>
            <Input
              id="admin-activity-email"
              type="text"
              placeholder="User email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
            />
            <Button type="submit" variant="outline">Filter</Button>
          </form>
        </div>
      </div>

      <CardBody isLoading={query.isLoading} isError={query.isError} label="activity">
        {!stored ? (
          <EmptyState message={UNSTORED_MESSAGE} />
        ) : events.length === 0 ? (
          <EmptyState message="No tool calls recorded yet." />
        ) : (
          <DataTable
            caption="Tool calls across all users"
            head={
              <tr>
                <th scope="col">Time</th>
                <th scope="col">User</th>
                <th scope="col">App</th>
                <th scope="col">Tool</th>
                <th scope="col">Status</th>
              </tr>
            }
          >
            {events.map((e) => {
              const app = e.integration ? appFor(e.integration).label : "—";
              return (
                <tr key={e.id}>
                  <td className="wb-cell-time">{dayLabel(e.created_at)} {timeLabel(e.created_at)}</td>
                  <td>{e.user_email ?? "—"}</td>
                  <td>{app}</td>
                  <td>
                    <code className="wb-mono">{e.tool ?? "—"}</code>
                    {!e.success && e.error && <div className="wb-cell-error" title={e.error}>{e.error}</div>}
                  </td>
                  <td>
                    <span className={e.success ? "wb-status-ok" : "wb-status-bad"}>
                      <span aria-hidden>{e.success ? "✓" : "✕"}</span> {e.success ? "Succeeded" : "Failed"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </CardBody>

      {query.hasNextPage && (
        <div className="wb-load-more">
          <Button variant="outline" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </Box>
  );
}
