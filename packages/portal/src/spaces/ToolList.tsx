import { Box, BoxRow } from "../components/ui/Box";
import { Badge } from "../components/ui/Badge";
import type { SpaceTool } from "../spaces-api";
import { isDestructive } from "./bridge";

export function effectLabel(tool: SpaceTool): { label: string; variant: "blue" | "orange" | "red" } {
  if (isDestructive(tool)) return { label: "Asks first", variant: "red" };
  if (tool.effect === "write") return { label: "Writes", variant: "orange" };
  return { label: "Reads", variant: "blue" };
}

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
export function SpaceToolList({ tools }: { tools: SpaceTool[] }) {
  const groups = groupTools(tools);
  if (groups.length === 0) {
    return <p className="space-muted">This Space uses no tools.</p>;
  }
  return (
    <div className="space-tool-groups">
      {groups.map((g) => (
        <Box
          key={g.integration}
          title={g.integrationName}
          action={g.connected ? null : <Badge variant="orange">Not connected</Badge>}
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
                  <Badge variant={effect.variant}>{effect.label}</Badge>
                </span>
              </BoxRow>
            );
          })}
        </Box>
      ))}
    </div>
  );
}
