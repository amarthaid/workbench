import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchIntegration,
  fetchConnections,
  exportSession,
  importSession,
  openBrowserLiveUrl,
  resetBrowserSession,
  removeCustomApp,
  updateCustomAppHeaders,
  type HeaderRow,
  type ReconnectStatus,
} from "../api";
import { PageHeader } from "../components/ui/PageHeader";
import { Box, BoxRow } from "../components/ui/Box";
import { EmptyState } from "../components/ui/EmptyState";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { ConfirmDialog } from "../components/dialogs/ConfirmDialog";
import { TypedNameConfirm } from "../components/dialogs/TypedNameConfirm";
import { RowAction, RowActions } from "../components/ui/RowActions";
import { ToolsAccordion } from "../components/ToolsAccordion";
import { integrationTools } from "../components/integration-tools";
import { AutoReconnectPanel } from "../components/AutoReconnectPanel";
import { CustomAppHeadersEditor } from "../components/CustomAppHeadersEditor";
import IntegrationLogo from "../components/IntegrationLogo";
import { useConnectFlow } from "../hooks/useConnectFlow";

export default function AppDetail() {
  const { name = "" } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["integration", name],
    queryFn: () => fetchIntegration(name),
    retry: false,
  });
  const { data: connectionsData } = useQuery({ queryKey: ["connections"], queryFn: fetchConnections });
  const flow = useConnectFlow();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function onDeleteApp() {
    if (!data) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await removeCustomApp(data.name.replace(/^custom:/, ""));
      navigate("/apps");
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed");
      setDeleteBusy(false);
    }
  }

  const connectionRow = useMemo(() => {
    const rows: { name: string; connected: boolean; autoReconnect?: ReconnectStatus }[] = connectionsData?.connections ?? [];
    return rows.find((c) => c.name === name);
  }, [connectionsData, name]);
  const connected = connectionRow?.connected === true;

  if (isLoading) {
    return (
      <>
        <PageHeader title="App" />
        <div className="ui-loading">Loading app…</div>
      </>
    );
  }

  if (error || !data) {
    return (
      <>
        <Link className="wb-page-back" to="/apps">← Apps</Link>
        <PageHeader title="Not found" />
        <Box>
          <EmptyState
            message="That app isn't in this registry."
            action={<Link to="/apps">Back to apps</Link>}
          />
        </Box>
      </>
    );
  }

  const label = data.displayName || data.name;
  const alwaysOn = data.authType === "none";
  // A headers app is connected by its stored headers: no OAuth to start or drop.
  const headersApp = data.custom === true && data.authType === "apikey";

  return (
    <>
      <Link className="wb-page-back" to="/apps">← Apps</Link>

      <PageHeader
        title={label}
        icon={<IntegrationLogo name={data.name} displayName={data.displayName} logo={data.logo} size={32} />}
        actions={
          alwaysOn ? undefined : (
            <>
              {!headersApp && (
                <Button variant="outline" onClick={() => flow.connect(data)}>
                  {connected ? "Reconnect" : "Connect"}
                </Button>
              )}
              <RowActions>
                {connected && !headersApp && (
                  <RowAction danger onClick={() => flow.disconnect(data.name)}>
                    Disconnect
                  </RowAction>
                )}
                {data.custom && (
                  <RowAction danger disabled={deleteBusy} onClick={() => setConfirmDelete(true)}>
                    Remove app
                  </RowAction>
                )}
              </RowActions>
            </>
          )
        }
      />

      {flow.error && <div className="ui-form-error">{flow.error}</div>}

      <div className="wb-section-gap">
        <Box title="Status">
          <BoxRow>
            <span className="wb-detail-desc">{data.description ?? "No description provided."}</span>
          </BoxRow>
          <BoxRow>
            <span className="wb-detail-key">Connection</span>
            <span className="wb-detail-val">
              {alwaysOn ? (
                <Badge variant="neutral">Built-in · always on</Badge>
              ) : connected ? (
                <Badge variant="green">Connected</Badge>
              ) : (
                <Badge variant="neutral">Not connected</Badge>
              )}
            </span>
          </BoxRow>
          <BoxRow>
            <span className="wb-detail-key">Auth</span>
            <span className="wb-detail-val">{data.authType}</span>
          </BoxRow>
          {!data.custom && (
            <BoxRow>
              <span className="wb-detail-key">Version</span>
              <span className="wb-detail-val">v{data.version}</span>
            </BoxRow>
          )}
          {data.categories && data.categories.length > 0 && (
            <BoxRow>
              <span className="wb-detail-key">Categories</span>
              <span className="wb-detail-val wb-chip-row">
                {data.categories.map((c) => <Badge key={c} variant="neutral">{c}</Badge>)}
              </span>
            </BoxRow>
          )}
          {data.instance && (
            <BoxRow>
              <span className="wb-detail-key">{data.instance.label}</span>
              <span className="wb-detail-val">{data.instance.default}</span>
            </BoxRow>
          )}
        </Box>

        {headersApp && (
          <CustomAppHeaders id={data.name.replace(/^custom:/, "")} names={data.headerNames ?? []} />
        )}
        {data.authType === "cookie" && <SessionTransfer name={data.name} />}
        {data.authType === "cookie" && data.autoReconnect && (
          <AutoReconnectPanel
            key={data.name}
            integration={data.name}
            credentials={data.autoReconnect.credentials}
            status={connectionRow?.autoReconnect}
          />
        )}
        {data.name === "browser" && <BrowserControls />}

        <Box title={`Tools (${data.tools.length})`}>
          {data.tools.length === 0 ? (
            <EmptyState message="This app exposes no tools." />
          ) : (
            <ToolsAccordion tools={integrationTools(data)} defaultOpen="all" singleApp />
          )}
        </Box>
      </div>

      {flow.dialogs}

      {confirmDelete && (
        <TypedNameConfirm
          title={`Remove ${label}?`}
          name={label}
          nameLabel="app name"
          confirmLabel="Remove app"
          busyLabel="Removing…"
          busy={deleteBusy}
          error={deleteError}
          impact={
            <ul className="space-delete-impact">
              <li>Its stored credentials are deleted.</li>
              <li>Agents lose its tools.</li>
              <li>This cannot be undone.</li>
            </ul>
          }
          onConfirm={() => void onDeleteApp()}
          onCancel={() => {
            setConfirmDelete(false);
            setDeleteError(null);
          }}
        />
      )}
    </>
  );
}

// Edit a headers app's header names and values. Stored values are never sent
// to the browser, so a blank value field keeps the stored one.
function CustomAppHeaders({ id, names }: { id: string; names: string[] }) {
  const [rows, setRows] = useState<HeaderRow[]>(() =>
    (names.length ? names : [""]).map((name) => ({ name, value: "" }))
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();

  // A value with no name would be silently dropped on save.
  const orphanValue = rows.some((h) => h.value !== "" && !h.name.trim());

  async function onSave() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await updateCustomAppHeaders(id, rows.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })));
      setRows((r.app.headerNames.length ? r.app.headerNames : [""]).map((name) => ({ name, value: "" })));
      setMsg({ ok: true, text: "Headers saved." });
      qc.invalidateQueries({ queryKey: ["integrations"] });
      qc.invalidateQueries({ queryKey: ["integration"] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box title="Headers">
      <BoxRow className="wb-row-stack">
        <p className="wb-detail-desc">
          Sent with every request to this server. Leave a value blank to keep the stored one; removing a row deletes the header.
        </p>
        <CustomAppHeadersEditor rows={rows} onChange={setRows} disabled={busy} valueOptional />
        <Button onClick={onSave} disabled={busy || orphanValue || !rows.some((h) => h.name.trim())}>Save headers</Button>
        {orphanValue && <div className="ui-form-error">Every header needs a name</div>}
        {msg && <div className={msg.ok ? "wb-ok" : "ui-form-error"}>{msg.text}</div>}
      </BoxRow>
    </Box>
  );
}

// Move a captured cookie session between workbenches. Capture on a machine the
// login provider trusts (e.g. a residential IP), export, then import into a
// headless/in-cluster workbench the provider would otherwise block.
function SessionTransfer({ name }: { name: string }) {
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  async function onExport() {
    setMsg(null);
    setBusy(true);
    try {
      const { session } = await exportSession(name);
      const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}-session.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text: "Exported — bundle downloaded. Keep it secret; it's a live session." });
    } catch (e) {
      setMsg({ ok: false, text: `Export failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    setMsg(null);
    setBusy(true);
    try {
      const session = JSON.parse(paste);
      const r = await importSession(name, session);
      setMsg({ ok: true, text: `Imported ${r.cookieCount} cookies — integration connected.` });
      setPaste("");
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["integrations"] });
    } catch (e) {
      const m = e instanceof SyntaxError ? "not valid JSON" : (e as Error).message;
      setMsg({ ok: false, text: `Import failed: ${m}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box title="Session transfer">
      <BoxRow className="wb-row-stack">
        <p className="wb-detail-desc">
          Capture on a machine the login provider accepts, <b>Export</b> the session, then <b>Import</b> it into a
          workbench whose IP the provider blocks (for example a headless or in-cluster instance).
        </p>
        <Button variant="outline" onClick={onExport} disabled={busy}>Export session</Button>
        <textarea
          className="ui-input"
          aria-label="Exported session bundle"
          placeholder="Paste an exported session bundle JSON here…"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={4}
        />
        <Button onClick={onImport} disabled={busy || !paste.trim()}>Import session</Button>
        {msg && <div className={msg.ok ? "wb-ok" : "ui-form-error"}>{msg.text}</div>}
      </BoxRow>
    </Box>
  );
}

// Built-in browser controls: open a live view (optionally at a URL) and clear
// the persistent profile.
function BrowserControls() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();

  async function onOpen() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await openBrowserLiveUrl(url.trim() || undefined);
      window.open(r.url, "_blank", "noopener");
      setMsg({ ok: true, text: "Live view opened in a new tab." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    setConfirmClear(false);
    setBusy(true);
    setMsg(null);
    try {
      await resetBrowserSession();
      setMsg({ ok: true, text: "Browser session cleared." });
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box title="Browser controls">
      <BoxRow className="wb-row-stack">
        <p className="wb-detail-desc">
          Open a live view to drive the browser by hand. Leave the URL blank to view the current page, or enter a URL to
          navigate there first.
        </p>
        <div className="wb-inline-row">
          <label className="ui-sr-only" htmlFor="browser-url">Navigate to</label>
          <Input
            id="browser-url"
            style={{ flex: 1 }}
            placeholder="https://example.com (optional)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button onClick={onOpen} disabled={busy}>Open live view</Button>
        </div>
        <Button variant="danger" onClick={() => setConfirmClear(true)} disabled={busy}>Clear session</Button>
        {msg && <div className={msg.ok ? "wb-ok" : "ui-form-error"}>{msg.text}</div>}
      </BoxRow>

      <ConfirmDialog
        open={confirmClear}
        title="Clear browser session"
        body="This signs the shared browser out of every site it is logged into. Cookie-auth integrations will need reconnecting."
        confirmLabel="Clear session"
        destructive
        onCancel={() => setConfirmClear(false)}
        onConfirm={onClear}
      />
    </Box>
  );
}
