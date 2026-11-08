// The server serves the portal, so its origin is also the /mcp origin.
export const MCP_URL = `${window.location.origin}/mcp`;

export const API_KEY_PLACEHOLDER = "YOUR_API_KEY";

// Generic MCP client config. `type: "http"` is required by Claude Code for a
// URL server (without it `--mcp-config` silently loads nothing); other
// clients accept or ignore it.
export function mcpConfigFor(key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        workbench: {
          type: "http",
          url: MCP_URL,
          headers: { "x-workbench-api-key": key },
        },
      },
    },
    null,
    2
  );
}
