import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  fetchStats,
  fetchActivity,
  fetchIntegrations,
  fetchConnections,
  UNSTORED_MESSAGE,
  type IntegrationSummary,
} from "../api";
import { MCP_URL } from "../mcp-config";
import { PageHeader } from "../components/ui/PageHeader";
import { StatStrip } from "../components/ui/StatStrip";
import { Box, BoxRow } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import IntegrationLogo from "../components/IntegrationLogo";
import { ActivityTable, integrationLookup } from "../components/ActivityTable";

const RECENT_LIMIT = 10;
const APPS_SHOWN = 8;

export default function Home() {
  const { data: stats } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const {
    data: recent,
    isError: recentIsError,
  } = useQuery({
    queryKey: ["activity", { limit: RECENT_LIMIT }],
    queryFn: () => fetchActivity({ limit: RECENT_LIMIT }),
  });
  const { data: registry, isError: registryIsError } = useQuery({
    queryKey: ["integrations"],
    queryFn: fetchIntegrations,
  });
  const { data: connectionsData, isError: connectionsIsError } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
  });

  const integrations: IntegrationSummary[] = registry?.integrations ?? [];

  const connectedNames = useMemo(() => {
    const rows: { name: string; connected: boolean }[] = connectionsData?.connections ?? [];
    return new Set(rows.filter((c) => c.connected).map((c) => c.name));
  }, [connectionsData]);

  const connectedApps = integrations.filter((i) => connectedNames.has(i.name));
  const appsError = registryIsError || connectionsIsError;

  const appFor = useMemo(() => integrationLookup(integrations), [integrations]);

  const stored = stats?.stored ?? true;
  const rate = stats?.success_rate;

  return (
    <>
      <PageHeader title="Home" />

      <div className="wb-section-gap">
        <StatStrip
          note={stored ? undefined : UNSTORED_MESSAGE}
          stats={[
            {
              label: "Tool calls (30d)",
              value: stored ? (stats?.tool_calls ?? 0).toLocaleString("en-US") : "—",
            },
            {
              // A null rate means nothing ran, which is not the same as 0%.
              label: "Success rate (30d)",
              value: stored && rate !== null && rate !== undefined ? `${Math.round(rate * 100)}%` : "—",
            },
            {
              label: "Most used app",
              value:
                stored && stats?.most_used_integration ? (
                  <span className="ui-stat-value-app">
                    <IntegrationLogo
                      name={stats.most_used_integration}
                      displayName={appFor(stats.most_used_integration).label}
                      logo={appFor(stats.most_used_integration).logo}
                      size={20}
                    />
                    {appFor(stats.most_used_integration).deleted ? (
                      <span className="wb-app-deleted">{appFor(stats.most_used_integration).label}</span>
                    ) : (
                      appFor(stats.most_used_integration).label
                    )}
                  </span>
                ) : (
                  "—"
                ),
            },
            { label: "Connected apps", value: String(connectedApps.length) },
          ]}
        />

        <Box title="Your apps" action={<Link to="/apps">Browse all</Link>}>
          {appsError ? (
            <div className="ui-form-error">Couldn't load apps.</div>
          ) : connectedApps.length === 0 ? (
            <EmptyState message="No apps connected yet." action={<Link to="/apps">Browse apps</Link>} />
          ) : (
            <>
              {connectedApps.slice(0, APPS_SHOWN).map((i) => (
                <BoxRow key={i.name}>
                  <IntegrationLogo name={i.name} displayName={i.displayName} logo={i.logo} size={20} />
                  <Link to={`/apps/${i.name}`}>{i.displayName || i.name}</Link>
                  <span className="wb-app-cell-meta">{i.toolCount} tools</span>
                  <span className="wb-app-cell-action"><Badge variant="green">Connected</Badge></span>
                </BoxRow>
              ))}
              {connectedApps.length > APPS_SHOWN && (
                <BoxRow>
                  <Link to="/apps">+{connectedApps.length - APPS_SHOWN} more</Link>
                </BoxRow>
              )}
            </>
          )}
        </Box>

        <Box title="Connect your agent" action={<Link to="/agents">Set up an agent</Link>}>
          <BoxRow>
            <span className="wb-detail-key">Endpoint</span>
            <code className="wb-mono">{MCP_URL}</code>
          </BoxRow>
        </Box>

        <Box title="Recent activity" action={<Link to="/activity">View all</Link>}>
          {recentIsError ? (
            <div className="ui-form-error">Couldn't load activity.</div>
          ) : recent && !recent.stored ? (
            <EmptyState message={UNSTORED_MESSAGE} />
          ) : (recent?.events.length ?? 0) === 0 ? (
            <EmptyState message="No tool calls recorded yet." />
          ) : (
            <ActivityTable events={recent!.events} caption="Ten most recent tool calls" appFor={appFor} />
          )}
        </Box>
      </div>
    </>
  );
}
