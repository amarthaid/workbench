import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchIntegration, type IntegrationSummary } from "../api";
import { Modal } from "./ui/Modal";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import IntegrationLogo from "./IntegrationLogo";
import { ToolsAccordion } from "./ToolsAccordion";
import { integrationTools } from "./integration-tools";

interface Props {
  integration: IntegrationSummary;
  connected: boolean;
  busy: boolean;
  /** Start the connect flow. The caller owns the flow and its dialogs. */
  onConnect: () => void;
  onClose: () => void;
}

function chipFor(i: IntegrationSummary, connected: boolean): { label: string; variant: "green" | "neutral" | "orange" } {
  if (i.authType === "none") return { label: "Built-in", variant: "neutral" };
  if (connected) return { label: "Connected", variant: "green" };
  if (i.configured === false) return { label: "Not configured", variant: "orange" };
  return { label: "Not connected", variant: "neutral" };
}

/**
 * A peek at one app from the Apps page: what it is, whether it is connected,
 * and what its tools can do. Forms and flows (headers, browser tools,
 * disconnect, removal) stay on the full page, one click away through Manage.
 */
export function AppQuickView({ integration: i, connected, busy, onConnect, onClose }: Props) {
  const label = i.displayName || i.name;
  const chip = chipFor(i, connected);
  const detail = useQuery({ queryKey: ["integration", i.name], queryFn: () => fetchIntegration(i.name), retry: false });
  const tools = detail.data ? integrationTools(detail.data) : [];
  // A headers app is connected by its stored headers: there is no flow to start.
  const headersApp = i.custom === true && i.authType === "apikey";
  const canConnect = i.authType !== "none" && i.configured !== false && !headersApp;

  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      className="app-quick-modal"
      ariaLabel={label}
      hero={
        <div className="app-quick-hero">
          <IntegrationLogo name={i.name} displayName={i.displayName} logo={i.logo} size={40} />
          <h2 className="app-quick-title">{label}</h2>
          <Badge variant={chip.variant}>{chip.label}</Badge>
        </div>
      }
      footer={
        <>
          <Link className="ui-button ui-button-outline ui-button-md" to={`/apps/${i.name}`}>
            Manage
          </Link>
          {canConnect && (
            <Button disabled={busy} onClick={onConnect}>
              {connected ? "Reconnect" : "Connect"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-detail-facts-line">
        {i.authType && <span className="space-detail-fact">Auth: {i.authType}</span>}
        {!i.custom && <span className="space-detail-fact">v{i.version}</span>}
        <span className="space-detail-fact">
          {i.toolCount} {i.toolCount === 1 ? "tool" : "tools"}
        </span>
      </div>
      {i.description && <p className="space-detail-desc">{i.description}</p>}
      <section className="space-detail-tools" aria-label="Tools">
        <h3 className="space-detail-subhead">Tools</h3>
        {detail.isLoading ? (
          <p className="space-muted">Loading tools...</p>
        ) : detail.isError ? (
          <p className="space-muted">Could not load the tools.</p>
        ) : tools.length === 0 ? (
          <p className="space-muted">This app exposes no tools.</p>
        ) : (
          <ToolsAccordion tools={tools} defaultOpen="all" singleApp />
        )}
      </section>
    </Modal>
  );
}
