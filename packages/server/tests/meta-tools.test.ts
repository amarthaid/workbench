import { describe, it, expect, beforeEach, vi } from "vitest";
import { metaTools } from "../src/mcp/meta-tools";
import { registry } from "../src/plugins/registry";

const mockTool = {
  name: "test_tool",
  description: "A test tool",
  integration: "test-integ",
  inputSchema: { type: "object" },
  handler: vi.fn(),
};

const mockOauthInteg = {
  name: "test-integ",
  version: "1.0.0",
  auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
};

const mockCookieInteg = {
  name: "legacy",
  version: "1.0.0",
  auth: { type: "cookie" as const, loginUrl: "https://legacy.com/login", targetDomain: "legacy.com", cookieDomains: [] },
};

vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(() => ({ userId: "user-1", getToken: vi.fn(), http: vi.fn() })),
}));

vi.mock("../src/audit/logger", () => ({
  auditLogger: { log: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../src/auth/tokens", () => ({
  getToken: vi.fn(),
}));

vi.mock("../src/auth/users", () => ({
  getUserById: vi.fn(),
}));

vi.mock("../src/auth/cookie", () => ({
  hasValidCookies: vi.fn(() => false),
  storeCookies: vi.fn(),
}));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: vi.fn(async () => ({ cdpToken: "tok-123" })),
  navigate: vi.fn(async (_s: unknown, url: string) => ({ url, title: "" })),
  captureLiveCookies: vi.fn(async () => ({ domain: "legacy.com", cookies: [], capturedAt: 1 })),
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

vi.mock("../src/config", () => ({
  config: { PORTAL_URL: "http://portal.test", CONNECT_TTL_SECONDS: 600 },
}));

vi.mock("../src/telemetry/tracing", () => ({
  withSpan: vi.fn((_name: string, fn: Function) => fn()),
}));

vi.mock("../src/vault/store", () => ({
  readSecretValue: vi.fn(async (_u: string, name: string) =>
    name === "pw" ? "hunter2" : name === "port" ? "5432" : null
  ),
  touchUsed: vi.fn(async () => undefined),
}));

function findTool(name: string) {
  return metaTools.find((t) => t.name === name)!;
}

describe("meta-tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("search_tools", () => {
    it("returns matching tools", async () => {
      vi.spyOn(registry, "searchTools").mockReturnValue([mockTool as any]);
      const tool = findTool("search_tools");
      const result = await tool.handler({ userId: "user-1" }, { query: "test" });
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("test_tool");
    });
  });

  describe("get_tool_schema", () => {
    it("returns schema for existing tool", async () => {
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      const tool = findTool("get_tool_schema");
      const result = await tool.handler({ userId: "user-1" }, { tool: "test_tool" });
      expect(result.schema).toEqual({ type: "object" });
    });

    it("returns portable JSON Schema, not raw Zod internals", async () => {
      const { z } = await import("zod");
      const zodTool = {
        name: "z_tool",
        description: "zod tool",
        integration: "test-integ",
        inputSchema: z.object({ query: z.string(), pageSize: z.number().default(10) }),
        handler: vi.fn(),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(zodTool as any);
      const tool = findTool("get_tool_schema");
      const result = await tool.handler({ userId: "user-1" }, { tool: "z_tool" });
      const s = JSON.stringify(result.schema);
      expect(result.schema.type).toBe("object");
      expect(result.schema.properties.query.type).toBe("string");
      expect(s).not.toContain("_def"); // no Zod internals leaked
    });

    it("returns error for missing tool", async () => {
      vi.spyOn(registry, "getTool").mockReturnValue(undefined);
      const tool = findTool("get_tool_schema");
      const result = await tool.handler({ userId: "user-1" }, { tool: "missing" });
      expect(result.error).toBe("Tool not found");
    });
  });

  // Per-item engine (executeSingle) is exercised through execute_tools with a
  // single execution — there is no longer a singular execute_tool meta-tool.
  describe("execute_tools (single execution)", () => {
    const runOne = (tool: any, exec: { tool: string; args: Record<string, unknown> }) =>
      tool.handler({ userId: "user-1" }, { executions: [exec] }).then((r: any) => r.results[0]);

    it("returns error when tool not found", async () => {
      vi.spyOn(registry, "getTool").mockReturnValue(undefined);
      const tool = findTool("execute_tools");
      const result = await runOne(tool, { tool: "missing", args: {} });
      expect(result.error).toBe("Tool not found");
    });

    it("returns NOT_CONNECTED when oauth token missing", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue(null);
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);

      const tool = findTool("execute_tools");
      const result = await runOne(tool, { tool: "test_tool", args: {} });
      expect(result.error).toBe("NOT_CONNECTED");
      expect(result.integration).toBe("test-integ");
    });

    it("returns NOT_CONNECTED when cookie invalid", async () => {
      const { hasValidCookies } = await import("../src/auth/cookie");
      vi.mocked(hasValidCookies).mockResolvedValue(false);
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg as any);

      const tool = findTool("execute_tools");
      const result = await runOne(tool, { tool: "test_tool", args: {} });
      expect(result.error).toBe("NOT_CONNECTED");
    });

    it("executes tool and returns result", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      mockTool.handler.mockResolvedValue({ done: true });

      const tool = findTool("execute_tools");
      const result = await runOne(tool, { tool: "test_tool", args: { x: 1 } });
      expect(result.result).toEqual({ done: true });
      expect(mockTool.handler).toHaveBeenCalledWith(expect.anything(), { x: 1 });
    });

    it("catches and returns handler errors", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      mockTool.handler.mockRejectedValue(new Error("boom"));

      const tool = findTool("execute_tools");
      const result = await runOne(tool, { tool: "test_tool", args: {} });
      expect(result.error).toBe("boom");
    });
  });

  describe("vault interpolation in executeSingle", () => {
    const runOne = (tool: any, exec: { tool: string; args: Record<string, unknown> }) =>
      tool.handler({ userId: "user-1" }, { executions: [exec] }).then((r: any) => r.results[0]);

    beforeEach(async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
    });

    it("substitutes before the handler and scrubs the result", async () => {
      const { z } = await import("zod");
      const echo = {
        name: "echo",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ echoed: `got ${a.text}` })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(echo as any);
      const result = await runOne(findTool("execute_tools"), {
        tool: "echo",
        args: { text: "pw={{vault:pw}}" },
      });
      expect(echo.handler).toHaveBeenCalledWith(expect.anything(), { text: "pw=hunter2" });
      expect(result.result).toEqual({ echoed: "got pw={{vault:pw}}" });
      const { touchUsed } = await import("../src/vault/store");
      expect(touchUsed).toHaveBeenCalledWith("user-1", ["pw"]);
    });

    it("runs before zod so coercion applies to the substituted value", async () => {
      const { z } = await import("zod");
      const t = {
        name: "num",
        integration: "test-integ",
        inputSchema: z.object({ port: z.coerce.number() }),
        handler: vi.fn(async (_c: unknown, a: { port: number }) => ({ port: a.port })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "num", args: { port: "{{vault:port}}" } });
      expect(t.handler).toHaveBeenCalledWith(expect.anything(), { port: 5432 });
      expect(result.result).toEqual({ port: "{{vault:port}}" });
    });

    it("fails closed on an unknown secret and never calls the handler", async () => {
      const t = { ...mockTool, handler: vi.fn() };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "test_tool", args: { x: "{{vault:nope}}" } });
      expect(result.error).toBe("VAULT_SECRET_NOT_FOUND");
      expect(result.message).toContain("nope");
      expect(t.handler).not.toHaveBeenCalled();
      const { auditLogger } = await import("../src/audit/logger");
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "VAULT_SECRET_NOT_FOUND" })
      );
    });

    it("scrubs a thrown error message", async () => {
      const { z } = await import("zod");
      const t = {
        name: "boom",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => {
          throw new Error(`upstream rejected ${a.text}`);
        }),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), { tool: "boom", args: { text: "{{vault:pw}}" } });
      expect(result.error).toBe("upstream rejected {{vault:pw}}");
      const { auditLogger } = await import("../src/audit/logger");
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "upstream rejected {{vault:pw}}" })
      );
    });

    it("leaves vault_* tool args untouched", async () => {
      const { z } = await import("zod");
      const t = {
        name: "vault_presign",
        integration: "vault",
        inputSchema: z.object({ name: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { name: string }) => ({ got: a.name })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue({ name: "vault", version: "1", auth: { type: "none" } } as any);
      const result = await runOne(findTool("execute_tools"), { tool: "vault_presign", args: { name: "{{vault:pw}}" } });
      expect(t.handler).toHaveBeenCalledWith(expect.anything(), { name: "{{vault:pw}}" });
      expect(result.result).toEqual({ got: "{{vault:pw}}" });
    });
  });

  describe("execute_tools (batch)", () => {
    it("runs multiple tools and returns ordered results", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getTool").mockReturnValue(mockTool as any);
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      mockTool.handler.mockImplementation(async (_ctx: unknown, args: any) => ({ echoed: args.x }));

      const tool = findTool("execute_tools");
      const result = await tool.handler(
        { userId: "user-1" },
        { executions: [{ tool: "test_tool", args: { x: 1 } }, { tool: "test_tool", args: { x: 2 } }] }
      );
      expect(result.results).toHaveLength(2);
      expect(result.results[0].result).toEqual({ echoed: 1 });
      expect(result.results[1].result).toEqual({ echoed: 2 });
    });

    it("isolates per-item failures without aborting the batch", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "getTool").mockImplementation((name: string) =>
        name === "test_tool" ? (mockTool as any) : undefined
      );
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      mockTool.handler.mockResolvedValue({ done: true });

      const tool = findTool("execute_tools");
      const result = await tool.handler(
        { userId: "user-1" },
        { executions: [{ tool: "missing", args: {} }, { tool: "test_tool", args: {} }] }
      );
      expect(result.results).toHaveLength(2);
      expect(result.results[0].error).toBe("Tool not found");
      expect(result.results[1].result).toEqual({ done: true });
    });
  });

  describe("list_integrations", () => {
    it("lists integrations with connection status", async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      vi.spyOn(registry, "listIntegrations").mockReturnValue([mockOauthInteg as any, mockCookieInteg as any]);

      const tool = findTool("list_integrations");
      const result = await tool.handler({ userId: "user-1" }, {});
      expect(result.integrations).toHaveLength(2);
      expect(result.integrations[0].connected).toBe(true);
    });
  });

  describe("whoami", () => {
    it("returns current user id and email", async () => {
      const { getUserById } = await import("../src/auth/users");
      vi.mocked(getUserById).mockResolvedValue({ id: "user-1", email: "a@b.com" });
      const tool = findTool("whoami");
      const result = await tool.handler({ userId: "user-1" }, {});
      expect(result).toEqual({ id: "user-1", email: "a@b.com" });
    });

    it("returns error when user not found", async () => {
      const { getUserById } = await import("../src/auth/users");
      vi.mocked(getUserById).mockResolvedValue(null);
      const tool = findTool("whoami");
      const result = await tool.handler({ userId: "ghost" }, {});
      expect(result).toEqual({ error: "User not found" });
    });
  });

  describe("get_auth_url", () => {
    it("returns url for oauth2 integration (alias of connect)", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      const tool = findTool("get_auth_url");
      const result = await tool.handler({ userId: "user-1" }, { integration: "test-integ" });
      expect(result.url).toContain("/connect/test-integ?t=jwt-123");
      expect(result.connectionId).toBe("conn-1");
    });
    it("returns cookie magic-link (alias of connect)", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg as any);
      const tool = findTool("get_auth_url");
      const result = await tool.handler({ userId: "user-1" }, { integration: "legacy" });
      expect(result.type).toBe("cookie");
      expect(result.url).toContain("/connect/legacy");
    });
    it("returns error for unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const tool = findTool("get_auth_url");
      const result = await tool.handler({ userId: "user-1" }, { integration: "missing" });
      expect(result.error).toBe("Integration not found");
    });
  });

  describe("connect", () => {
    it("returns provider URL + connectionId for oauth2", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
      const tool = findTool("connect");
      const result = await tool.handler({ userId: "user-1" }, { integration: "test-integ" });
      expect(result.connectionId).toBe("conn-1");
      expect(result.type).toBe("oauth2");
      expect(result.url).toContain("/connect/test-integ?t=jwt-123");
    });

    it("connect returns a workbench link for an oauth2 integration", async () => {
      const { buildPluginAuthUrl } = await import("../src/auth/plugin-oauth");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "github",
        version: "1.0.0",
        auth: { type: "oauth2" as const, scopes: ["repo"] },
      } as never);

      const tool = findTool("connect");
      const result = await tool.handler({ userId: "user-1" }, { integration: "github" });

      expect(result.type).toBe("oauth2");
      expect(result.url).toMatch(/\/connect\/github\?t=/);
      expect(result.url).not.toContain("provider.example");
      // The provider URL is built at redeem time, by a proven owner.
      expect(buildPluginAuthUrl).not.toHaveBeenCalled();
    });

    it("returns a portal magic-link + connectionId for cookie without navigating to loginUrl", async () => {
      const { navigate } = await import("../src/auth/browser-session");
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg as any);
      const tool = findTool("connect");
      const result = await tool.handler({ userId: "user-1" }, { integration: "legacy" });
      expect(result.connectionId).toBe("conn-1");
      expect(result.type).toBe("cookie");
      expect(result.url).toContain("/connect/legacy?t=jwt-123");
      expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    });

    it("connect does not warm a browser session for a cookie integration", async () => {
      const { ensureSession } = await import("../src/auth/browser-session");
      vi.spyOn(registry, "getIntegration").mockReturnValue({
        name: "legacy",
        version: "1.0.0",
        auth: {
          type: "cookie" as const,
          loginUrl: "https://legacy.example.com/login",
          targetDomain: "legacy.example.com",
          cookieDomains: [],
        },
      } as never);

      const result = await findTool("connect").handler({ userId: "user-1" }, { integration: "legacy" });

      expect(result.type).toBe("cookie");
      expect(result.url).toMatch(/\/connect\/legacy\?t=/);
      expect(ensureSession).not.toHaveBeenCalled();
    });

    it("always returns a login link, even when live cookies already exist (cookie)", async () => {
      const { captureLiveCookies } = await import("../src/auth/browser-session");
      const { storeCookies } = await import("../src/auth/cookie");
      const { markConnected } = await import("../src/auth/connections");
      // Live cookies present, but connect must never auto-connect from them.
      vi.mocked(captureLiveCookies).mockResolvedValue({
        domain: "legacy.com",
        cookies: [{ name: "sid", value: "abc", domain: "legacy.com", path: "/" }],
        capturedAt: 123,
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockCookieInteg as any);

      const tool = findTool("connect");
      const result = await tool.handler({ userId: "user-1" }, { integration: "legacy" });
      expect(result.connectionId).toBe("conn-1");
      expect(result.type).toBe("cookie");
      expect(result.url).toContain("/connect/legacy?t=");
      expect(result.connected).toBeUndefined();
      expect(storeCookies).not.toHaveBeenCalled();
      expect(markConnected).not.toHaveBeenCalled();
    });

    it("returns error for unknown integration", async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(undefined);
      const tool = findTool("connect");
      const result = await tool.handler({ userId: "user-1" }, { integration: "missing" });
      expect(result.error).toBe("Integration not found");
    });
  });

  describe("wait_for_connection", () => {
    it("returns CONNECTED when the record is connected", async () => {
      const { getPending } = await import("../src/auth/connections");
      vi.mocked(getPending).mockReturnValue({ status: "CONNECTED", userId: "user-1" } as any);
      const tool = findTool("wait_for_connection");
      const result = await tool.handler({ userId: "user-1" }, { connectionId: "conn-1", timeoutSec: 1 });
      expect(result.status).toBe("CONNECTED");
    });

    it("returns TIMEOUT and reaps when never connected", async () => {
      const { getPending, reapOne } = await import("../src/auth/connections");
      vi.mocked(getPending).mockReturnValue({ status: "PENDING", userId: "user-1" } as any);
      const tool = findTool("wait_for_connection");
      const result = await tool.handler({ userId: "user-1" }, { connectionId: "conn-1", timeoutSec: 1 });
      expect(result.status).toBe("TIMEOUT");
      expect(reapOne).toHaveBeenCalledWith("conn-1");
    });

    it("returns EXPIRED when the record is expired", async () => {
      const { getPending } = await import("../src/auth/connections");
      vi.mocked(getPending).mockReturnValue({ status: "EXPIRED", userId: "user-1" } as any);
      const tool = findTool("wait_for_connection");
      const result = await tool.handler({ userId: "user-1" }, { connectionId: "conn-1", timeoutSec: 1 });
      expect(result.status).toBe("EXPIRED");
    });

    it("returns error for unknown connectionId", async () => {
      const { getPending } = await import("../src/auth/connections");
      vi.mocked(getPending).mockReturnValue(undefined);
      const tool = findTool("wait_for_connection");
      const result = await tool.handler({ userId: "user-1" }, { connectionId: "nope", timeoutSec: 1 });
      expect(result.error).toBe("Unknown connectionId");
    });

    it("rejects access to another user's connection (IDOR)", async () => {
      const { getPending } = await import("../src/auth/connections");
      vi.mocked(getPending).mockReturnValue({ status: "CONNECTED", userId: "other-user" } as any);
      const tool = findTool("wait_for_connection");
      const result = await tool.handler({ userId: "user-1" }, { connectionId: "conn-1", timeoutSec: 1 });
      expect(result.error).toBe("Unknown connectionId");
    });
  });
});
