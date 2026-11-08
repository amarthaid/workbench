import { describe, it, expect } from "vitest";
import { mcpConfigFor, MCP_URL, API_KEY_PLACEHOLDER } from "./mcp-config";

describe("mcpConfigFor", () => {
  it("produces client config JSON carrying the key in the workbench header", () => {
    const parsed = JSON.parse(mcpConfigFor("tok-abc"));
    expect(parsed.mcpServers.workbench.url).toBe(MCP_URL);
    expect(parsed.mcpServers.workbench.type).toBe("http");
    expect(parsed.mcpServers.workbench.headers["x-workbench-api-key"]).toBe("tok-abc");
  });

  it("points at the /mcp path on the serving origin", () => {
    expect(MCP_URL).toBe(`${window.location.origin}/mcp`);
  });

  it("exposes a placeholder for the no-key-yet case", () => {
    expect(JSON.parse(mcpConfigFor(API_KEY_PLACEHOLDER)).mcpServers.workbench.headers["x-workbench-api-key"])
      .toBe("YOUR_API_KEY");
  });
});
