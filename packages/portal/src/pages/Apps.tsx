import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchIntegrations, fetchConnections, createCustomApp, type IntegrationSummary } from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Tabs } from "../components/ui/Tabs";
import { EmptyState } from "../components/ui/EmptyState";
import { Input, Select } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import IntegrationLogo from "../components/IntegrationLogo";
import { useConnectFlow } from "../hooks/useConnectFlow";

type Filter = "all" | "connected" | "available";

export default function Apps() {
  const { data, isLoading, isError } = useQuery({ queryKey: ["integrations"], queryFn: fetchIntegrations });
  const { data: connectionsData, isError: connectionsIsError } = useQuery({
    queryKey: ["connections"],
    queryFn: fetchConnections,
  });
  const { connect, error, busy, dialogs } = useConnectFlow();
  const qc = useQueryClient();

  const [showNewApp, setShowNewApp] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState<string | null>(null);

  async function submitNewApp(e: React.FormEvent) {
    e.preventDefault();
    setNewError(null);
    setNewBusy(true);
    try {
      await createCustomApp(newName.trim(), newUrl.trim());
      setNewName("");
      setNewUrl("");
      setShowNewApp(false);
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Failed to register custom app");
    } finally {
      setNewBusy(false);
    }
  }

  const [filter, setFilter] = useState<Filter>("all");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");

  const connectionMap = useMemo<Map<string, boolean>>(() => {
    const entries: [string, boolean][] =
      connectionsData?.connections?.map((c: { name: string; connected: boolean }) => [c.name, c.connected]) ?? [];
    return new Map(entries);
  }, [connectionsData]);

  const integrations: IntegrationSummary[] = data?.integrations ?? [];
  const connectedCount = integrations.filter((i) => connectionMap.get(i.name)).length;

  const categories = useMemo(() => {
    const set = new Set<string>();
    integrations.forEach((i) => i.categories?.forEach((c) => set.add(c)));
    return Array.from(set).sort();
  }, [integrations]);

  // Connected first, then anything connectable, then integrations whose auth
  // this deployment has not configured.
  function rank(i: IntegrationSummary): number {
    if (connectionMap.get(i.name)) return 0;
    if (i.configured !== false) return 1;
    return 2;
  }

  const needle = search.trim().toLowerCase();
  const visible = integrations
    .filter((i) => {
      const connected = connectionMap.get(i.name) ?? false;
      if (filter === "connected" && !connected) return false;
      if (filter === "available" && connected) return false;
      if (category !== "all" && !i.categories?.includes(category)) return false;
      if (needle) {
        const hay = `${i.displayName ?? ""} ${i.name} ${i.description ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => rank(a) - rank(b));

  if (isLoading) {
    return (
      <>
        <PageHeader title="Apps" />
        <div className="ui-loading">Loading apps…</div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Apps"
        actions={<Button onClick={() => setShowNewApp(true)}>New custom app</Button>}
        toolbar={
          <>
            <Tabs
              label="Filter apps"
              value={filter}
              onChange={(id) => setFilter(id as Filter)}
              items={[
                { id: "all", label: "All", count: integrations.length },
                { id: "connected", label: "Connected", count: connectedCount },
                { id: "available", label: "Available", count: integrations.length - connectedCount },
              ]}
            />
            <div className="wb-toolbar-controls">
              <label className="ui-sr-only" htmlFor="apps-search">Search apps</label>
              <Input
                id="apps-search"
                type="search"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {categories.length > 0 && (
                <>
                  <label className="ui-sr-only" htmlFor="apps-category">Category</label>
                  <Select id="apps-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="all">All categories</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                </>
              )}
            </div>
          </>
        }
      />

      {error && <div className="ui-form-error">{error}</div>}

      {isError || connectionsIsError ? (
        <div className="ui-form-error">Couldn't load apps.</div>
      ) : visible.length === 0 ? (
        <EmptyState message="No apps match this filter." />
      ) : (
        <div className="wb-app-grid">
          {visible.map((i) => (
            <AppCell
              key={i.name}
              integration={i}
              connected={connectionMap.get(i.name) ?? false}
              busy={busy === i.name}
              onConnect={() => connect(i)}
            />
          ))}
        </div>
      )}

      {dialogs}

      <Modal
        open={showNewApp}
        onClose={() => setShowNewApp(false)}
        title="New custom app"
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => setShowNewApp(false)}>Cancel</Button>
            <Button type="submit" form="new-custom-app-form" disabled={newBusy || !newName.trim() || !newUrl.trim()}>
              {newBusy ? "Registering…" : "Create"}
            </Button>
          </>
        }
      >
        <form id="new-custom-app-form" className="wb-section-gap" onSubmit={submitNewApp}>
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="new-app-name">Name</label>
            <Input id="new-app-name" placeholder="notion" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </div>
          <div className="ui-field">
            <label className="ui-field-label" htmlFor="new-app-url">MCP server URL</label>
            <Input id="new-app-url" placeholder="https://mcp.example.com/mcp" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} />
          </div>
          {newError && <div className="ui-form-error">{newError}</div>}
        </form>
      </Modal>
    </>
  );
}

function AppCell({
  integration: i,
  connected,
  busy,
  onConnect,
}: {
  integration: IntegrationSummary;
  connected: boolean;
  busy: boolean;
  onConnect: () => void;
}) {
  const label = i.displayName || i.name;
  const configured = i.configured !== false;

  // The navigable half and the action half are siblings, never nested: a
  // <button> inside an <a> is invalid HTML, and every workaround for the
  // resulting click ambiguity is worse than not creating it.
  const lead = (
    <>
      <IntegrationLogo name={i.name} displayName={i.displayName} logo={i.logo} size={24} />
      <span className="wb-app-cell-text">
        <span className="wb-app-cell-name">{label}</span>
        <span className="wb-app-cell-meta">v{i.version} · {i.toolCount} tools</span>
      </span>
    </>
  );

  const action =
    i.authType === "none" ? (
      <Badge variant="neutral">Built-in</Badge>
    ) : connected ? (
      <Badge variant="green">Connected</Badge>
    ) : configured ? (
      <Button size="xs" variant="outline" disabled={busy} aria-label={`Connect ${label}`} onClick={onConnect}>
        {busy ? "…" : "Connect"}
      </Button>
    ) : (
      <span className="wb-app-cell-muted">Not configured</span>
    );

  return (
    <div className={`wb-app-cell${configured ? "" : " wb-app-cell-inert"}`}>
      {configured ? (
        <Link className="wb-app-cell-link" to={`/apps/${i.name}`}>
          {lead}
        </Link>
      ) : (
        <span className="wb-app-cell-link">{lead}</span>
      )}
      <span className="wb-app-cell-action">{action}</span>
    </div>
  );
}
