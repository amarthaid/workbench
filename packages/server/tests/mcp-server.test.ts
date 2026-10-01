import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleMcpRequest } from "../src/mcp/server";
import { registry } from "../src/plugins/registry";

vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(() => ({ userId: "user-1", getToken: vi.fn(), http: vi.fn() })),
}));

vi.mock("../src/auth/tokens", () => ({
  getToken: vi.fn(() => ({ accessToken: "tok", scopes: "" })),
}));

vi.mock("../src/auth/cookie", () => ({
  hasValidCookies: vi.fn(() => false),
  storeCookies: vi.fn(),
}));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: vi.fn(async () => ({ cdpToken: "cdp-1" })),
  captureLiveCookies: vi.fn(async () => ({ domain: "legacy.com", cookies: [], capturedAt: 1 })),
  touch: vi.fn(),
  navigate: vi.fn(),
  screenshot: vi.fn(),
  click: vi.fn(),
  typeText: vi.fn(),
  pressKey: vi.fn(),
  scroll: vi.fn(),
  readText: vi.fn(),
  closeBrowserSession: vi.fn(),
}));

vi.mock("../src/auth/connections", () => ({
  createPending: vi.fn(() => ({ connectionId: "conn-1", status: "PENDING" })),
  getPending: vi.fn(),
  reapOne: vi.fn(async () => undefined),
  markConnected: vi.fn(),
}));

vi.mock("../src/auth/connect-token", () => ({
  signConnectToken: vi.fn(async () => "jwt-123"),
}));

vi.mock("../src/auth/plugin-oauth", () => ({
  buildPluginAuthUrl: vi.fn(() => "https://provider.example/oauth?x=1"),
}));

vi.mock("../src/telemetry/tracing", () => ({
  withSpan: vi.fn((_name: string, fn: Function) => fn()),
}));

describe("handleMcpRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists tools", async () => {
    const res = await handleMcpRequest({ method: "tools/list", id: 1 }, "user-1");
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    expect(res.result.tools).toBeInstanceOf(Array);
    expect(res.result.tools.length).toBeGreaterThan(0);
    expect(res.result.tools[0]).toHaveProperty("name");
    expect(res.result.tools[0]).toHaveProperty("description");
  });

  it("calls a tool and returns result", async () => {
    const mockTool = {
      name: "test_tool",
      description: "Test",
      integration: "test-integ",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockResolvedValue({ done: true }),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "test-integ",
      version: "1.0.0",
      auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
    } as any);

    const res = await handleMcpRequest(
      { method: "tools/call", id: 2, params: { name: "search_tools", arguments: { query: "test" } } },
      "user-1"
    );
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(2);
    expect(res.result.content[0].type).toBe("text");
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed).toHaveProperty("tools");
  });

  it("returns error for unknown tool", async () => {
    const res = await handleMcpRequest(
      { method: "tools/call", id: 3, params: { name: "unknown_tool", arguments: {} } },
      "user-1"
    );
    expect(res.jsonrpc).toBe("2.0");
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("Tool not found");
  });

  it("returns error for invalid arguments", async () => {
    const res = await handleMcpRequest(
      { method: "tools/call", id: 4, params: { name: "search_tools", arguments: { wrong: 1 } } },
      "user-1"
    );
    expect(res.jsonrpc).toBe("2.0");
    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("Invalid arguments");
  });

  describe("search_tools limit", () => {
    const tools = ["alpha_one", "alpha_two", "alpha_three"].map((name) => ({
      name,
      description: "alpha tool",
      integration: "test-integ",
      inputSchema: {},
      handler: vi.fn(),
    }));
    const search = async (args: Record<string, unknown>) => {
      vi.spyOn(registry, "listTools").mockReturnValue(tools as any);
      return handleMcpRequest({ method: "tools/call", id: 5, params: { name: "search_tools", arguments: args } }, "user-1");
    };

    it("accepts a number", async () => {
      const res = await search({ query: "alpha", limit: 2 });
      expect(JSON.parse(res.result.content[0].text).tools).toHaveLength(2);
    });

    // A client that cached tools/list before `limit` existed sends it untyped, as a string.
    it("accepts a numeric string", async () => {
      const res = await search({ query: "alpha", limit: "1" });
      expect(JSON.parse(res.result.content[0].text).tools).toHaveLength(1);
    });

    it.each([["abc"], ["0"], ["51"], ["2.5"]])("rejects %j", async (limit) => {
      const res = await search({ query: "alpha", limit });
      expect(res.error.code).toBe(-32602);
      expect(res.error.message).toContain("Invalid arguments");
    });
  });

  it("returns error for unknown method", async () => {
    const res = await handleMcpRequest({ method: "unknown", id: 5 }, "user-1");
    expect(res.jsonrpc).toBe("2.0");
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain("Method not found");
  });

  it("handles execute_tools via mcp call", async () => {
    const mockTool = {
      name: "exec_tool",
      description: "Exec",
      integration: "test-integ",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockResolvedValue({ result: "ok" }),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "test-integ",
      version: "1.0.0",
      auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 6,
        params: { name: "execute_tools", arguments: { executions: [{ tool: "exec_tool", args: {} }] } },
      },
      "user-1"
    );
    expect(res.jsonrpc).toBe("2.0");
    expect(res.result.content[0].type).toBe("text");
  });

  it("returns NOT_CONNECTED when token missing", async () => {
    const { getToken } = await import("../src/auth/tokens");
    vi.mocked(getToken).mockResolvedValue(null);

    const mockTool = {
      name: "exec_tool",
      description: "Exec",
      integration: "test-integ",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn(),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "test-integ",
      version: "1.0.0",
      auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 7,
        params: { name: "execute_tools", arguments: { executions: [{ tool: "exec_tool", args: {} }] } },
      },
      "user-1"
    );
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.results[0].error).toBe("NOT_CONNECTED");
  });

  it("returns error when handler throws", async () => {
    const { getToken } = await import("../src/auth/tokens");
    vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });

    const mockTool = {
      name: "exec_tool",
      description: "Exec",
      integration: "test-integ",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockRejectedValue(new Error("handler-error")),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "test-integ",
      version: "1.0.0",
      auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 8,
        params: { name: "execute_tools", arguments: { executions: [{ tool: "exec_tool", args: {} }] } },
      },
      "user-1"
    );
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.results[0].error).toBe("handler-error");
  });

  it("lists integrations via mcp call", async () => {
    vi.spyOn(registry, "listIntegrations").mockReturnValue([
      { name: "slack", version: "1.0.0", auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] } },
    ]);

    const res = await handleMcpRequest(
      { method: "tools/call", id: 9, params: { name: "list_integrations", arguments: {} } },
      "user-1"
    );
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.integrations).toBeInstanceOf(Array);
    expect(parsed.integrations[0].name).toBe("slack");
  });

  it("wraps a normal result as text", async () => {
    const res = await handleMcpRequest(
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "search_tools", arguments: { query: "x" } } },
      "user-1"
    );
    const r = res?.result as { content: { type: string }[] };
    expect(r.content[0].type).toBe("text");
  });

  it("returns cookie magic-link via mcp call (get_auth_url alias)", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "legacy",
      version: "1.0.0",
      auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com", cookieDomains: [] },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 10,
        params: { name: "get_auth_url", arguments: { integration: "legacy" } },
      },
      "user-1"
    );
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.type).toBe("cookie");
    expect(parsed.url).toContain("/connect/legacy");
  });

  it("does not navigate or warm a session when connecting a cookie integration", async () => {
    const { navigate, ensureSession } = await import("../src/auth/browser-session");
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "legacy",
      version: "1.0.0",
      auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com", cookieDomains: [] },
    } as any);

    await handleMcpRequest(
      { method: "tools/call", id: 30, params: { name: "connect", arguments: { integration: "legacy" } } },
      "user-1"
    );

    // Warming a session and navigating happens at /api/connect/redeem, once a
    // human has proved they own this account — not at mint time.
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    expect(vi.mocked(ensureSession)).not.toHaveBeenCalled();
  });

  it("treats none-auth (built-in) tools as always connected", async () => {
    const { getToken } = await import("../src/auth/tokens");
    vi.mocked(getToken).mockResolvedValue(null); // no token stored — must not matter

    const mockTool = {
      name: "browser_close",
      description: "Close",
      integration: "browser",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockResolvedValue({ ok: true }),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "browser",
      version: "1.0.0",
      auth: { type: "none" as const },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 20,
        params: { name: "execute_tools", arguments: { executions: [{ tool: "browser_close", args: {} }] } },
      },
      "user-1"
    );
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed).toEqual({ results: [{ result: { ok: true } }] });
  });

  it("hoists an _mcpImage sentinel nested under execute_tools' result wrapper", async () => {
    const mockTool = {
      name: "browser_screenshot",
      description: "Shot",
      integration: "browser",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockResolvedValue({ _mcpImage: { data: "b64", mimeType: "image/jpeg" } }),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "browser",
      version: "1.0.0",
      auth: { type: "none" as const },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 21,
        params: { name: "execute_tools", arguments: { executions: [{ tool: "browser_screenshot", args: {} }] } },
      },
      "user-1"
    );
    expect(res.result.content[0]).toEqual({ type: "image", data: "b64", mimeType: "image/jpeg" });
  });

  it("emits one image block per sentinel in an execute_tools batch", async () => {
    // Two screenshots in one batch: the renderer digs into results[] and
    // surfaces both as image blocks (no text block when every result is an image).
    let shot = 0;
    const mockTool = {
      name: "browser_screenshot",
      description: "Shot",
      integration: "browser",
      inputSchema: { type: "object" as const, properties: {} },
      handler: vi.fn().mockImplementation(async () => ({
        _mcpImage: { data: `b64-${++shot}`, mimeType: "image/jpeg" },
      })),
    };
    vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: "browser",
      version: "1.0.0",
      auth: { type: "none" as const },
    } as any);

    const res = await handleMcpRequest(
      {
        method: "tools/call",
        id: 22,
        params: {
          name: "execute_tools",
          arguments: {
            executions: [
              { tool: "browser_screenshot", args: {} },
              { tool: "browser_screenshot", args: {} },
            ],
          },
        },
      },
      "user-1"
    );
    expect(res.result.content).toHaveLength(2);
    expect(res.result.content.every((c: any) => c.type === "image")).toBe(true);
    expect(res.result.content.map((c: any) => c.data).sort()).toEqual(["b64-1", "b64-2"]);
  });
});
