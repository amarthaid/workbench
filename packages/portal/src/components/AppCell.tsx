import type { IntegrationSummary } from "../api";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import IntegrationLogo from "./IntegrationLogo";

/** The compact app tile shared by the Apps page and Home: the body opens the app, the half beside it acts. */
export function AppCell({
  integration: i,
  connected,
  busy,
  onOpen,
  onConnect,
}: {
  integration: IntegrationSummary;
  connected: boolean;
  busy: boolean;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const label = i.displayName || i.name;
  const configured = i.configured !== false;

  // The body that opens the quick view and the action half are sibling
  // buttons, never nested: a <button> inside a <button> is invalid HTML, and
  // every workaround for the resulting click ambiguity is worse than not
  // creating it.
  const lead = (
    <>
      <IntegrationLogo name={i.name} displayName={i.displayName} logo={i.logo} size={24} />
      <span className="wb-app-cell-text">
        <span className="wb-app-cell-name">{label}</span>
        <span className="wb-app-cell-meta">
          {i.custom ? `${i.toolCount} tools · MCP server` : `v${i.version} · ${i.toolCount} tools`}
        </span>
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
      <button type="button" className="wb-app-cell-link" onClick={onOpen}>
        {lead}
      </button>
      <span className="wb-app-cell-action">{action}</span>
    </div>
  );
}
