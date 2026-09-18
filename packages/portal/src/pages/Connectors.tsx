import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchConnectors,
  createConnector,
  removeConnector,
  startConnectorAuth,
  type ConnectorSummary,
} from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog";

const STATUS_MESSAGES: Record<string, { tone: "ok" | "error"; text: string }> = {
  ok: { tone: "ok", text: "Connected." },
  denied: { tone: "error", text: "Authorization denied." },
  expired: { tone: "error", text: "That connect link expired — try again." },
  failed: { tone: "error", text: "Connection failed — see the server log." },
};

export default function Connectors() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, isError } = useQuery({ queryKey: ["connectors"], queryFn: fetchConnectors });

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectorSummary | null>(null);

  const status = searchParams.get("status");
  const statusMessage = status ? STATUS_MESSAGES[status] : undefined;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createConnector(name.trim(), baseUrl.trim());
      setName("");
      setBaseUrl("");
      qc.invalidateQueries({ queryKey: ["connectors"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to register");
    } finally {
      setSubmitting(false);
    }
  }

  async function connect(c: ConnectorSummary) {
    setError(null);
    setBusy(c.id);
    try {
      const { url } = await startConnectorAuth(c.id);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
      setBusy(null);
    }
  }

  async function confirmDelete() {
    const c = pendingDelete;
    setPendingDelete(null);
    if (!c) return;
    setBusy(c.id);
    try {
      await removeConnector(c.id);
      qc.invalidateQueries({ queryKey: ["connectors"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  const connectors = data?.connectors ?? [];

  return (
    <>
      <PageHeader title="Connectors" />

      {statusMessage && (
        <div className={`wb-banner wb-banner-${statusMessage.tone}`}>
          <span>{statusMessage.text}</span>
          <Button size="xs" variant="ghost" onClick={() => setSearchParams({}, { replace: true })}>
            Dismiss
          </Button>
        </div>
      )}

      <form className="wb-connector-form" onSubmit={submit}>
        <div className="ui-field" style={{ flex: "1 1 180px" }}>
          <label className="ui-field-label" htmlFor="connector-name">Name</label>
          <Input
            id="connector-name"
            placeholder="github-mcp"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="ui-field" style={{ flex: "1 1 260px" }}>
          <label className="ui-field-label" htmlFor="connector-url">MCP server URL</label>
          <Input
            id="connector-url"
            placeholder="https://mcp.example.com/mcp"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
          />
        </div>
        <div className="ui-field" style={{ justifyContent: "flex-end" }}>
          <Button type="submit" disabled={submitting || !name.trim() || !baseUrl.trim()}>
            {submitting ? "Registering…" : "Add connector"}
          </Button>
        </div>
      </form>

      {error && <div className="ui-form-error">{error}</div>}

      {isLoading ? (
        <div className="ui-loading">Loading connectors…</div>
      ) : isError ? (
        <div className="ui-form-error">Couldn't load connectors.</div>
      ) : connectors.length === 0 ? (
        <EmptyState message="No connectors yet. Register an MCP server above to expose its tools here." />
      ) : (
        <ul className="wb-connector-list">
          {connectors.map((c) => (
            <li key={c.id} className="wb-connector-row">
              <div className="wb-connector-text">
                <span className="wb-connector-name">{c.name}</span>
                <span className="wb-connector-url">{c.baseUrl}</span>
              </div>
              <span className="wb-connector-action">
                {c.connected ? (
                  <Badge variant="green">Connected</Badge>
                ) : (
                  <Badge variant="neutral">Not connected</Badge>
                )}
                <Button size="xs" variant="outline" disabled={busy === c.id} onClick={() => connect(c)}>
                  {busy === c.id ? "…" : c.connected ? "Reconnect" : "Connect"}
                </Button>
                <Button size="xs" variant="ghost" disabled={busy === c.id} onClick={() => setPendingDelete(c)}>
                  Delete
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.name ?? ""}`}
        body="This removes the connector and its stored credentials. Agents will lose its tools."
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  );
}
