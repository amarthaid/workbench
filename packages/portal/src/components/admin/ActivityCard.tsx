import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  fetchAdminActivity,
  fetchAdminActivityPayload,
  fetchIntegrations,
  UNSTORED_MESSAGE,
  type AdminActivityEvent,
  type IntegrationSummary,
} from "../../api";
import { dayLabel, durationLabel, timeLabel } from "../../format";
import { integrationLookup } from "../ActivityTable";
import { ActivityDrawer, activityRowProps } from "../ActivityDrawer";
import { ActivityFilters, defaultFilters, filtersToOpts, type AppliedFilters } from "../ActivityFilters";
import { SpaceCombobox } from "../SpaceCombobox";
import { Badge } from "../ui/Badge";
import { Box } from "../ui/Box";
import { Button } from "../ui/Button";
import { DataTable } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { ADMIN_STALE_MS, CardBody } from "./CardBody";
import { UserEmailCombobox } from "./UserEmailCombobox";

const PAGE_SIZE = 50;

/** The Space a call went through, from the credential's client name. */
function spaceOf(e: AdminActivityEvent): string | null {
  return e.client_name?.startsWith("space:") ? e.client_name.slice("space:".length) || null : null;
}

/** Someone other than the owner ran the call on the owner's access. */
function isDelegated(e: AdminActivityEvent): boolean {
  return !!e.actor_user_id && e.actor_user_id !== e.user_id;
}

export default function ActivityCard() {
  const [filters, setFilters] = useState<AppliedFilters>(() => defaultFilters());
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const opts = useMemo(() => ({ limit: PAGE_SIZE, ...filtersToOpts(filters, "admin") }), [filters]);

  const query = useInfiniteQuery({
    queryKey: ["admin", "activity", opts],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchAdminActivity({ ...opts, cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    // A focus refetch of an infinite query re-requests every loaded page.
    staleTime: ADMIN_STALE_MS,
  });

  const { data: registry } = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const integrations = (registry?.integrations ?? []) as IntegrationSummary[];
  const appFor = useMemo(() => integrationLookup(integrations), [integrations]);
  const integrationOptions = useMemo(
    () => integrations.map((i) => ({ name: i.name, label: i.displayName || i.name })),
    [integrations]
  );

  const pages = query.data?.pages ?? [];
  const stored = pages[0]?.stored ?? true;
  // De-duplicate by id: a refetch of an earlier page racing a "Load more" can
  // otherwise land the same row twice. The drawer reads a delegated row's
  // people and Space from `delegation`, which the admin endpoint does not send.
  const pageData = query.data?.pages;
  const events = useMemo(() => {
    const seen = new Set<number>();
    return (pageData ?? [])
      .flatMap((p) => p.events)
      .filter((e: AdminActivityEvent) => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      })
      .map((e): AdminActivityEvent =>
        isDelegated(e)
          ? { ...e, delegation: { direction: "for_me", other_email: e.actor_email ?? null, space: spaceOf(e) } }
          : e
      );
  }, [pageData]);

  const applyUser = (email: string) => setFilters((f) => ({ ...f, user: email }));
  const applySpace = (name: string) => setFilters((f) => ({ ...f, space: name }));

  return (
    <Box title="Activity">
      <ActivityFilters
        value={filters}
        onChange={setFilters}
        integrations={integrationOptions}
        spaceField={(slot) => (
          <SpaceCombobox source={{ kind: "remote" }} id={slot.id} value={slot.value} onChange={slot.onChange} />
        )}
        partyField={{
          kind: "user",
          render: (slot) => <UserEmailCombobox id={slot.id} value={slot.value} onChange={slot.onChange} />,
        }}
      />

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
                <th scope="col">Duration</th>
                <th scope="col">Status</th>
              </tr>
            }
          >
            {events.map((e) => {
              const app = e.integration ? appFor(e.integration).label : "—";
              const space = spaceOf(e);
              return (
                <tr key={e.id} {...activityRowProps(e.id, selectedId, setSelectedId)}>
                  <td className="wb-cell-time">{dayLabel(e.created_at)} {timeLabel(e.created_at)}</td>
                  <td>
                    {e.user_email ?? "—"}
                    <RequestOrigin event={e} />
                  </td>
                  <td>{app}</td>
                  <td>
                    <code className="wb-mono">{e.tool ?? "—"}</code>
                    {e.delegation ? (
                      <div className="wb-cell-delegation">
                        <Badge variant="orange">Delegated</Badge>
                        <span>
                          Run by{" "}
                          {e.actor_email ? (
                            <button type="button" className="af-link" onClick={() => applyUser(e.actor_email!)}>
                              {e.actor_email}
                            </button>
                          ) : (
                            "someone"
                          )}
                          {space && (
                            <>
                              {" · "}
                              <button type="button" className="af-link" onClick={() => applySpace(space)}>
                                {space}
                              </button>
                            </>
                          )}
                        </span>
                      </div>
                    ) : (
                      space && <div className="ui-stat-note">via Space {space}</div>
                    )}
                    {!e.success && e.error && <div className="wb-cell-error" title={e.error}>{e.error}</div>}
                  </td>
                  <td className="ui-num">{durationLabel(e.duration_ms)}</td>
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

      <ActivityDrawer
        admin
        events={events}
        selectedId={selectedId}
        onSelect={setSelectedId}
        appLabel={(name) => appFor(name).label}
        payloadSection={(event) => <AdminPayload key={event.id} event={event as AdminActivityEvent} />}
      />

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

function formatBytes(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Pretty-print when the text is whole JSON; a truncated value is shown as stored. */
function pretty(text: string, truncated: boolean): string {
  if (truncated) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function PayloadSection({
  title,
  text,
  truncated,
  bytes,
}: {
  title: string;
  text: string | null;
  truncated: boolean;
  bytes: number | null;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {text === null ? (
        <p className="ui-stat-note">Not captured.</p>
      ) : (
        <>
          {truncated && (
            <p className="ui-stat-note" role="note">
              Truncated: showing the first part of {formatBytes(bytes)}.
            </p>
          )}
          <pre className="wb-mono" style={{ maxHeight: "40vh", overflow: "auto", whiteSpace: "pre-wrap" }}>
            {pretty(text, truncated)}
          </pre>
        </>
      )}
    </section>
  );
}

function AdminPayload({ event }: { event: AdminActivityEvent }) {
  // Each read is audited server-side, so nothing is requested until Show.
  const [shown, setShown] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["admin", "activity-payload", event.id],
    queryFn: () => fetchAdminActivityPayload(event.id),
    enabled: shown && event.has_payload === true,
    // Do not refetch behind the admin's back.
    staleTime: Infinity,
    retry: false,
  });
  if (!event.has_payload) return <p className="ui-stat-note">Not captured.</p>;
  if (!shown) {
    return (
      <>
        <p className="ui-stat-note">Viewing these is recorded in the audit log under your name.</p>
        <Button variant="outline" size="sm" onClick={() => setShown(true)}>Show</Button>
      </>
    );
  }
  if (isLoading) return <p>Loading…</p>;
  if (isError || !data) return <p role="alert">Couldn't load the captured arguments and result.</p>;
  return (
    <>
      <PayloadSection title="Arguments" text={data.args} truncated={data.args_truncated} bytes={data.args_bytes} />
      <PayloadSection title="Result" text={data.result} truncated={data.result_truncated} bytes={data.result_bytes} />
    </>
  );
}

const AUTH_LABELS: Record<string, string> = {
  api_key: "API key",
  oauth: "OAuth",
  session: "Portal",
  curl_token: "Curl token",
};

/** How and from where the call came: auth method, OAuth client, IP; the user agent on hover. */
function RequestOrigin({ event: e }: { event: AdminActivityEvent }) {
  const parts = [
    e.auth_method
      ? (AUTH_LABELS[e.auth_method] ?? e.auth_method) + (e.client_name && !spaceOf(e) ? `: ${e.client_name}` : "")
      : null,
    e.source_ip ?? null,
  ].filter(Boolean);
  if (parts.length === 0 && !e.user_agent) return null;
  return (
    <div className="ui-stat-note" title={e.user_agent ?? undefined}>
      {parts.join(" · ") || "—"}
      {e.user_agent && <span className="ui-sr-only"> · {e.user_agent}</span>}
    </div>
  );
}
