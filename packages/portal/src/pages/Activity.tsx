import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchActivity, fetchIntegrations, UNSTORED_MESSAGE, type ActivityEvent, type IntegrationSummary } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { ActivityFilters, defaultFilters, filtersToOpts, type AppliedFilters } from "../components/ActivityFilters";
import { ActivityDrawer } from "../components/ActivityDrawer";
import { SpaceCombobox } from "../components/SpaceCombobox";
import { PersonCombobox } from "../components/PersonCombobox";
import { Button } from "../components/ui/Button";
import { ActivityTable, integrationLookup } from "../components/ActivityTable";
import { fetchSpaces } from "../spaces-api";

const PAGE_SIZE = 50;

export default function Activity() {
  const [applied, setApplied] = useState<AppliedFilters>(() => defaultFilters());
  const [selectedId, setSelectedId] = useState<number | null>(null);
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

  const filters = useMemo(() => ({ limit: PAGE_SIZE, ...filtersToOpts(applied, "personal") }), [applied]);

  // Changing a filter starts a fresh list. Reset the paged-in tail here, in the
  // event handler — not inside queryFn, which must stay a pure fetch: React
  // Query may call it on refetch, retry or remount, and a setState in there
  // fires on every one of those.
  function changeFilter(next: AppliedFilters) {
    setApplied(next);
    setSelectedId(null);
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

  // Spaces the viewer owns or is shared on: the Space filter's options, and
  // titles for the names rows carry.
  const { data: spaces } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces });
  const localSpaces = useMemo(() => (spaces ?? []).map((s) => ({ name: s.name, title: s.title })), [spaces]);
  const spaceTitle = useMemo(() => {
    const titles = new Map((spaces ?? []).map((s) => [s.name, s.title]));
    return (name: string) => titles.get(name) || name;
  }, [spaces]);
  const appLabel = (name: string) => appFor(name).label;

  return (
    <>
      <PageHeader title="Activity" />

      <ActivityFilters
        value={applied}
        onChange={changeFilter}
        integrations={integrations.map((i) => ({ name: i.name, label: i.displayName || i.name }))}
        spaceField={(slot) => <SpaceCombobox source={{ kind: "local", spaces: localSpaces }} {...slot} />}
        partyField={{
          kind: "person",
          render: (slot) => <PersonCombobox since={applied.since} until={applied.until} {...slot} />,
        }}
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
          <ActivityTable
            events={events}
            caption="Tool call history"
            appFor={appFor}
            spaceTitle={spaceTitle}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onPerson={(email) => changeFilter({ ...applied, person: email, delegated: true })}
            onSpace={(name) => changeFilter({ ...applied, space: name })}
          />
        )}
      </Box>

      <ActivityDrawer
        events={events}
        selectedId={selectedId}
        onSelect={setSelectedId}
        appLabel={appLabel}
        spaceTitle={spaceTitle}
      />

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
