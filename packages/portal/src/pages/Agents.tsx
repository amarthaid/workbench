import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAgents, revokeAgent, getApiKeyStatus, type ConnectedAgent } from "../api";
import { MCP_URL, API_KEY_PLACEHOLDER, mcpConfigFor } from "../mcp-config";
import { relativeTime } from "../format";
import { PageHeader } from "../components/ui/PageHeader";
import { Box, BoxRow } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { ListRow } from "../components/ui/ListRow";
import { RowAction, RowActions } from "../components/ui/RowActions";
import { ListSkeleton } from "../components/ui/ListSkeleton";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog";

export default function Agents() {
  const qc = useQueryClient();
  const { data: keyStatus } = useQuery({ queryKey: ["api-key-status"], queryFn: getApiKeyStatus });
  const { data, isLoading, isError } = useQuery({ queryKey: ["agents"], queryFn: fetchAgents });

  const [pendingRevoke, setPendingRevoke] = useState<ConnectedAgent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const agents: ConnectedAgent[] = data?.agents ?? [];
  const hasKey = keyStatus?.hasKey ?? false;
  const config = mcpConfigFor(API_KEY_PLACEHOLDER);

  function copy(text: string) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  async function confirmRevoke() {
    const agent = pendingRevoke;
    setPendingRevoke(null);
    if (!agent) return;
    setError(null);
    try {
      await revokeAgent(agent.client_id);
      qc.invalidateQueries({ queryKey: ["agents"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Revoke failed");
    }
  }

  return (
    <>
      <PageHeader title="Agents" />

      {error && <div className="ui-form-error">{error}</div>}

      <div className="wb-section-gap">
        <Box
          title="Connect an agent"
          action={<Badge variant={hasKey ? "green" : "neutral"}>{hasKey ? "Key active" : "No key"}</Badge>}
        >
          <BoxRow>
            <span className="wb-detail-key">Endpoint</span>
            <code className="wb-mono">{MCP_URL}</code>
          </BoxRow>
          <BoxRow className="wb-row-stack">
            <p className="wb-detail-desc">
              Point any MCP-compatible client at that endpoint and send your key in the{" "}
              <code className="wb-mono">x-workbench-api-key</code> header.
            </p>
            <pre className="wb-code"><code>{config}</code></pre>
            <div className="wb-inline-row">
              <Button variant="outline" onClick={() => copy(config)}>
                {copied ? "Copied" : "Copy config"}
              </Button>
              <Link to="/settings">Manage API key</Link>
            </div>
          </BoxRow>
        </Box>

        <Box title={`Connected agents (${agents.length})`}>
          {isLoading ? (
            <ListSkeleton rows={3} />
          ) : isError ? (
            <div className="ui-form-error">Couldn't load agents.</div>
          ) : agents.length === 0 ? (
            <EmptyState message="No agents connected." />
          ) : (
            agents.map((a) => {
              const label = a.client_name || a.client_id;
              return (
                <ListRow
                  key={a.client_id}
                  icon={<span className="ui-list-row-initial">{label.charAt(0).toUpperCase()}</span>}
                  title={label}
                  chips={a.scopes.map((sc) => (
                    <Badge key={sc} variant="neutral">{sc}</Badge>
                  ))}
                  subtitle={
                    <>
                      <code className="wb-mono">{a.client_id}</code>
                      {" · "}
                      Connected {relativeTime(a.connected_since)}
                    </>
                  }
                  actions={
                    <RowActions>
                      <RowAction
                        danger
                        aria-label={`Revoke ${label} (${a.client_id})`}
                        onClick={() => setPendingRevoke(a)}
                      >
                        Revoke
                      </RowAction>
                    </RowActions>
                  }
                />
              );
            })
          )}
        </Box>
      </div>

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={pendingRevoke ? `Revoke access for ${pendingRevoke.client_name || pendingRevoke.client_id} (${pendingRevoke.client_id})?` : ""}
        body="This agent will stop being able to renew its access. A session already in flight may keep working until its access token expires."
        confirmLabel="Revoke"
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={confirmRevoke}
      />
    </>
  );
}
