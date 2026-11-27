import { Box, BoxRow } from "../components/ui/Box";
import { Badge } from "../components/ui/Badge";
import type { SpaceTool } from "../spaces-api";
import { Segmented } from "../components/ui/Segmented";
import { Switch } from "../components/ui/Switch";

type Mode = "auto" | "ask";

// What the tool does, nothing about whether it asks first.
export function effectLabel(tool: SpaceTool): { label: string; variant: "blue" | "orange" | "red" } {
  if (tool.effect === "read") return { label: "Reads", variant: "blue" };
  if (tool.effect === "write") return { label: "Writes", variant: "orange" };
  return { label: "Deletes or changes", variant: "red" };
}

/** The mode a non-read tool has until someone changes it: writes run, anything else asks. */
export function defaultApproval(tool: SpaceTool): Mode {
  return tool.effect === "write" ? "auto" : "ask";
}

// A tool whose mode this viewer may change: not a read, not missing, and the server says so.
const isEditable = (t: SpaceTool) => t.effect !== "read" && !t.missing && t.approval !== undefined && t.approvalEditable !== false;

interface Group {
  integration: string;
  integrationName: string;
  connected: boolean;
  tools: SpaceTool[];
}

function groupTools(tools: SpaceTool[]): Group[] {
  const groups = new Map<string, Group>();
  for (const tool of tools) {
    let g = groups.get(tool.integration);
    if (!g) {
      g = { integration: tool.integration, integrationName: tool.integrationName || tool.integration, connected: true, tools: [] };
      groups.set(tool.integration, g);
    }
    if (!tool.missing && tool.connected === false) g.connected = false;
    g.tools.push(tool);
  }
  return [...groups.values()];
}

// The declared tools, one box per integration, each tagged with what it does.
// Used by the consent screen and by the running Space's "View tools".
// `delegation`: the list an owner lends; a tool that never runs with someone
// else's access is tagged Owner only.
export function SpaceToolList({
  tools,
  connectHref,
  delegation = false,
  hideConnection = false,
  approvals,
  onApprovalChange,
}: {
  tools: SpaceTool[];
  /** When set, an unconnected integration gets a Connect link to this URL. */
  connectHref?: (integration: string) => string;
  delegation?: boolean;
  /**
   * No connection state at all: a viewer of a delegated Space, whose tools run
   * with the owner's connections, has nothing to connect.
   */
  hideConnection?: boolean;
  /** Current choices by tool name; a tool not listed shows its own `approval`. */
  approvals?: Record<string, Mode>;
  /** When set, a changeable tool gets a control and the boxes get Allow all; without it the list shows badges. */
  onApprovalChange?: (change: Record<string, Mode>) => void;
}) {
  const groups = groupTools(tools);
  if (groups.length === 0) {
    return <p className="space-muted">This Space uses no tools.</p>;
  }
  const editing = !!onApprovalChange;
  const modeOf = (t: SpaceTool): Mode => approvals?.[t.name] ?? t.approval ?? defaultApproval(t);
  // Allow all: on sets every tool to auto; off puts each back to its default.
  const allowAllProps = (list: SpaceTool[]) => {
    const on = list.length > 0 && list.every((t) => modeOf(t) === "auto");
    return {
      checked: on,
      onChange: (next: boolean) =>
        onApprovalChange?.(Object.fromEntries(list.map((t) => [t.name, next ? "auto" : defaultApproval(t)] as const))),
    };
  };
  const editable = editing ? tools.filter(isEditable) : [];
  const boxesWithControls = editing ? groups.filter((g) => g.tools.some(isEditable)).length : 0;
  // The viewer's own line: some tool has a mode and none of them can be changed
  // here. Not in the owner's lending review: the owner is the one who decides.
  const showBadges =
    !delegation &&
    !tools.some(isEditable) &&
    tools.some((t) => t.effect !== "read" && !t.missing && t.approval !== undefined);
  return (
    <div className="space-tool-groups">
      {showBadges && <p className="space-muted">The owner decides which actions ask first.</p>}
      {editable.length > 0 && (
        <div className="space-allow-all">
          {boxesWithControls > 1 && (
            <label className="space-allow-all-row">
              <Switch aria-label="Allow all" {...allowAllProps(editable)} />
              <span>Allow all</span>
            </label>
          )}
          <p className="space-muted">Actions run without asking you, even after this Space's page changes.</p>
        </div>
      )}
      {groups.map((g) => {
        const boxEditable = editing ? g.tools.filter(isEditable) : [];
        return (
        <Box
          key={g.integration}
          title={g.integrationName}
          action={
            <>
            {boxEditable.length > 0 && (
              <label className="space-allow-all-row">
                <Switch aria-label={`Allow all for ${g.integrationName}`} {...allowAllProps(boxEditable)} />
                <span>Allow all</span>
              </label>
            )}
            {hideConnection ? null : g.connected ? (
              connectHref ? <Badge variant="green">Connected</Badge> : null
            ) : (
              <span className="space-tool-connect">
                <Badge variant="orange">Not connected</Badge>
                {connectHref && (
                  <a
                    className="ui-button ui-button-outline ui-button-sm"
                    href={connectHref(g.integration)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Connect
                  </a>
                )}
              </span>
            )}
            </>
          }
        >
          {g.tools.map((t) => {
            const effect = effectLabel(t);
            return (
              <BoxRow key={t.name} className="space-tool-row">
                <span className="space-tool-text">
                  <span className="wb-mono">{t.name}</span>
                  {t.description && <span className="space-tool-desc">{t.description}</span>}
                </span>
                <span className="space-tool-tags">
                  {t.missing && <Badge variant="neutral">Missing</Badge>}
                  {delegation && !t.missing && t.delegable === false && <Badge variant="neutral">Owner only</Badge>}
                  <Badge variant={effect.variant}>{effect.label}</Badge>
                  {editing && isEditable(t) ? (
                    <Segmented<Mode>
                      label={`Approval for ${t.name}`}
                      value={modeOf(t)}
                      options={[
                        { value: "auto", label: "Always allow" },
                        { value: "ask", label: "Ask first" },
                      ]}
                      onChange={(next) => onApprovalChange?.({ [t.name]: next })}
                    />
                  ) : (
                    t.effect !== "read" &&
                    t.approval !== undefined && (
                      <Badge variant={t.approval === "auto" ? "neutral" : "red"}>
                        {t.approval === "auto" ? "Runs without asking" : "Asks first"}
                      </Badge>
                    )
                  )}
                </span>
              </BoxRow>
            );
          })}
        </Box>
        );
      })}
    </div>
  );
}
