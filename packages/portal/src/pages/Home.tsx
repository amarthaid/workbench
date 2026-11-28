import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  fetchStats,
  fetchActivity,
  fetchIntegrations,
  fetchConnections,
  fetchVaultSecrets,
  UNSTORED_MESSAGE,
  type IntegrationSummary,
} from "../api";
import { fetchSpaces } from "../spaces-api";
import { MCP_URL } from "../mcp-config";
import { PageHeader } from "../components/ui/PageHeader";
import { StatStrip } from "../components/ui/StatStrip";
import { Box, BoxRow } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { ListSkeleton } from "../components/ui/ListSkeleton";
import { Button } from "../components/ui/Button";
import { CheckIcon, CopyIcon } from "../components/ui/Icons";
import IntegrationLogo from "../components/IntegrationLogo";
import { AppCell } from "../components/AppCell";
import { arrangeSpaces } from "../spaces/arrange";
import { useSpaceGallery } from "../spaces/useSpaceGallery";
import { ActivityTable, integrationLookup } from "../components/ActivityTable";

const RECENT_LIMIT = 10;
const APPS_SHOWN = 8;
const SPACES_SHOWN = 6;

export default function Home() {
  const navigate = useNavigate();
  const { data: stats, isLoading: statsLoading } = useQuery({ queryKey: ["stats"], queryFn: fetchStats });
  const {
    data: recent,
    isError: recentIsError,
    isLoading: recentLoading,
  } = useQuery({
    queryKey: ["activity", { limit: RECENT_LIMIT }],
    queryFn: () => fetchActivity({ limit: RECENT_LIMIT }),
  });
  const { data: registry, isError: registryIsError, isLoading: registryLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: fetchIntegrations,
  });
  const { data: connectionsData, isError: connectionsIsError, isLoading: connectionsLoading } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
  });

  const { data: secrets, isError: vaultIsError } = useQuery({
    queryKey: ["vault"],
    queryFn: fetchVaultSecrets,
  });

  const {
    data: spacesData,
    isError: spacesIsError,
    isLoading: spacesLoading,
  } = useQuery({ queryKey: ["spaces"], queryFn: fetchSpaces });
  const spaces = spacesData ?? [];
  const { tile, modals } = useSpaceGallery(spaces);
  const topSpaces = useMemo(() => {
    const { favorites, recent: opened, rest } = arrangeSpaces(spaces);
    return [...favorites, ...opened, ...rest].slice(0, SPACES_SHOWN);
  }, [spaces]);

  const integrations: IntegrationSummary[] = registry?.integrations ?? [];

  const connectedNames = useMemo(() => {
    const rows: { name: string; connected: boolean }[] = connectionsData?.connections ?? [];
    return new Set(rows.filter((c) => c.connected).map((c) => c.name));
  }, [connectionsData]);

  const connectedApps = integrations.filter((i) => connectedNames.has(i.name));
  const appsError = registryIsError || connectionsIsError;
  const appsLoading = registryLoading || connectionsLoading;

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
              loading: statsLoading,
              value: stored ? (stats?.tool_calls ?? 0).toLocaleString("en-US") : "—",
            },
            {
              // A null rate means nothing ran, which is not the same as 0%.
              label: "Success rate (30d)",
              loading: statsLoading,
              value: stored && rate !== null && rate !== undefined ? `${Math.round(rate * 100)}%` : "—",
            },
            {
              label: "Most used app",
              loading: statsLoading || registryLoading,
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
            { label: "Connected apps", value: String(connectedApps.length), loading: appsLoading },
          ]}
        />

        <Box title="Your apps" action={<Link to="/apps">Browse all</Link>}>
          {appsError ? (
            <div className="ui-form-error">Couldn't load apps.</div>
          ) : appsLoading ? (
            <div className="wb-box-tiles" role="status" aria-label="Loading">
              <div className="wb-app-grid">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="wb-app-cell wb-app-cell-skeleton" aria-hidden="true">
                    <span className="ui-list-skeleton-bar wb-app-cell-skeleton-logo" />
                    <span className="ui-list-skeleton-bar ui-list-skeleton-title" />
                  </div>
                ))}
              </div>
            </div>
          ) : connectedApps.length === 0 ? (
            <EmptyState message="No apps connected yet." action={<Link to="/apps">Browse apps</Link>} />
          ) : (
            <div className="wb-box-tiles">
              <div className="wb-app-grid">
                {connectedApps.slice(0, APPS_SHOWN).map((i) => (
                  <AppCell
                    key={i.name}
                    integration={i}
                    connected
                    busy={false}
                    onOpen={() => navigate(`/apps/${i.name}`)}
                    onConnect={() => {}}
                  />
                ))}
              </div>
              {connectedApps.length > APPS_SHOWN && <Link to="/apps">+{connectedApps.length - APPS_SHOWN} more</Link>}
            </div>
          )}
        </Box>

        <Box title="Your Spaces" action={<Link to="/spaces" aria-label="Browse all Spaces">Browse all</Link>}>
          {spacesIsError ? (
            <div className="ui-form-error">Couldn't load Spaces.</div>
          ) : spacesLoading ? (
            <ListSkeleton rows={2} />
          ) : topSpaces.length === 0 ? (
            <EmptyState message="No Spaces yet." action={<Link to="/spaces">About Spaces</Link>} />
          ) : (
            <div className="wb-box-tiles">
              <div className="space-grid is-two">{topSpaces.map((s) => tile(s, "compact"))}</div>
            </div>
          )}
        </Box>

        <Box title="Vault" action={<Link to="/vault">Manage</Link>}>
          <BoxRow>
            <span className="wb-detail-key">Secrets</span>
            <span className="wb-detail-val">
              {vaultIsError
                ? "Couldn't load vault."
                : secrets === undefined
                  ? <span role="status" aria-label="Loading" className="ui-stat-skeleton" />
                  : secrets.length === 0
                    ? "None yet"
                    : `${secrets.length} stored`}
            </span>
            <span className="wb-app-cell-action"><Link to="/vault/new">Add secret</Link></span>
          </BoxRow>
          <BoxRow>
            <span className="wb-detail-key">One-time link</span>
            <span className="wb-app-cell-meta">Hand over a value once, without storing it</span>
            <span className="wb-app-cell-action"><Link to="/vault/one-time">Create</Link></span>
          </BoxRow>
        </Box>

        <Box title="Connect your agent" action={<Link to="/agents">Set up an agent</Link>}>
          <BoxRow>
            <span className="wb-detail-key">Endpoint</span>
            <code className="wb-mono">{MCP_URL}</code>
            <CopyUrlButton />
          </BoxRow>
        </Box>

        <Box title="Recent activity" action={<Link to="/activity">View all</Link>}>
          {recentIsError ? (
            <div className="ui-form-error">Couldn't load activity.</div>
          ) : recentLoading ? (
            <ListSkeleton rows={3} />
          ) : recent && !recent.stored ? (
            <EmptyState message={UNSTORED_MESSAGE} />
          ) : (recent?.events.length ?? 0) === 0 ? (
            <EmptyState message="No tool calls recorded yet." />
          ) : (
            <ActivityTable events={recent!.events} caption="Ten most recent tool calls" appFor={appFor} />
          )}
        </Box>
      </div>
      {modals}
    </>
  );
}

/** Icon-only copy for the MCP endpoint; flips to a check for a moment once copied. */
function CopyUrlButton() {
  const [copied, setCopied] = useState(false);
  const label = copied ? "Copied" : "Copy MCP URL";

  function copy() {
    navigator.clipboard?.writeText(MCP_URL).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <Button variant="ghost" size="xs" className="ui-button-icon" aria-label={label} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
