import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchActivity, fetchIntegrations, UNSTORED_MESSAGE, type ActivityEvent, type IntegrationSummary } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Tabs } from "../components/ui/Tabs";
import { Select } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { ActivityTable, integrationLookup } from "../components/ActivityTable";
import { fetchSpaces } from "../spaces-api";

const PAGE_SIZE = 50;

export default function Activity() {
  const [status, setStatus] = useState<"all" | "error">("all");
  const [integration, setIntegration] = useState("all");
  // Pages already fetched, kept so "Load more" appends rather than replaces.
  const [older, setOlder] = useState<ActivityEvent[]>([]);
  // Three states, and the distinction matters: `undefined` means we have not
  // paged yet, so the cursor to use is whatever the first page returned; a
  // string means we paged and more remains; `null` means we paged and reached
  // the end. Collapsing "not yet paged" into "no rows paged in" would break the
  // ordinary end-of-list case, where the final page comes back empty.
  const [pagedCursor, setPagedCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      limit: PAGE_SIZE,
      ...(status === "error" ? { status: "error" as const } : {}),
      ...(integration !== "all" ? { integration } : {}),
    }),
    [status, integration]
  );

  // Changing a filter starts a fresh list. Reset the paged-in tail here, in the
  // event handler — not inside queryFn, which must stay a pure fetch: React
  // Query may call it on refetch, retry or remount, and a setState in there
  // fires on every one of those.
  function changeFilter(apply: () => void) {
    apply();
    setOlder([]);
    setPagedCursor(undefined);
    setLoadMoreError(null);
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ["activity", filters],
    queryFn: () => fetchActivity(filters),
  });

  // Page 1 refetching invalidates everything paged in beneath it — those rows
  // were positioned relative to a page 1 that no longer exists.
  const seenBase = useRef<typeof data>(undefined);
  useEffect(() => {
    if (data && seenBase.current && data !== seenBase.current) {
      setOlder([]);
      setPagedCursor(undefined);
    }
    seenBase.current = data;
  }, [data]);

  // Until "Load more" is pressed, the cursor to offer is the first page's.
  const nextCursor = pagedCursor === undefined ? (data?.next_cursor ?? null) : pagedCursor;

  const { data: registry } = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });

  const appFor = useMemo(
    () => integrationLookup((registry?.integrations ?? []) as IntegrationSummary[]),
    [registry]
  );

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await fetchActivity({ ...filters, cursor: nextCursor });
      setOlder((prev) => [...prev, ...page.events]);
      setPagedCursor(page.next_cursor);
    } catch (e) {
      setLoadMoreError(e instanceof Error ? e.message : "Couldn't load more activity.");
    } finally {
      setLoadingMore(false);
    }
  }

  // De-duplicate by id: a page-1 refetch racing with an in-flight "Load more"
  // can otherwise land the same row in both `data.events` and `older`.
  const events = useMemo(() => {
    const seen = new Set<number>();
    return [...(data?.events ?? []), ...older].filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [data, older]);
  const integrations = (registry?.integrations ?? []) as IntegrationSummary[];

  // Delegated rows name a Space by its name; show its title when this viewer
  // can still see it. Fetched only when such a row is on screen.
  const hasDelegated = events.some((e) => e.delegation?.space);
  const { data: spaces } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces, enabled: hasDelegated });
  const spaceTitle = useMemo(() => {
    const titles = new Map((spaces ?? []).map((s) => [s.name, s.title]));
    return (name: string) => titles.get(name) ?? name;
  }, [spaces]);

  return (
    <>
      <PageHeader
        title="Activity"
        toolbar={
          <>
            <Tabs
              label="Filter activity"
              value={status}
              onChange={(id) => changeFilter(() => setStatus(id as "all" | "error"))}
              items={[{ id: "all", label: "All" }, { id: "error", label: "Errors" }]}
            />
            <div className="wb-toolbar-controls">
              <label className="ui-sr-only" htmlFor="activity-integration">Integration</label>
              <Select
                id="activity-integration"
                value={integration}
                onChange={(e) => changeFilter(() => setIntegration(e.target.value))}
              >
                <option value="all">All apps</option>
                {integrations.map((i) => (
                  <option key={i.name} value={i.name}>{i.displayName || i.name}</option>
                ))}
              </Select>
            </div>
          </>
        }
      />

      <Box>
        {isLoading ? (
          <div className="ui-loading">Loading activity…</div>
        ) : isError ? (
          <div className="ui-form-error">Couldn't load activity.</div>
        ) : data && !data.stored ? (
          <EmptyState message={UNSTORED_MESSAGE} />
        ) : events.length === 0 ? (
          <EmptyState message="No tool calls recorded yet." />
        ) : (
          <ActivityTable events={events} caption="Tool call history" appFor={appFor} spaceTitle={spaceTitle} />
        )}
      </Box>

      {loadMoreError && <div className="ui-form-error">{loadMoreError}</div>}

      {nextCursor && (
        <div className="wb-load-more">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
