import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
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

vi.mock("../src/custom-apps/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custom-apps/index")>()),
  ensureIndex: vi.fn(async () => []),
}));

vi.mock("../src/custom-apps/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custom-apps/store")>()),
}));

vi.mock("../src/custom-apps/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custom-apps/oauth")>()),
}));

vi.mock("../src/custom-apps/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/custom-apps/client")>()),
}));

vi.mock("../src/auth/cookie", () => ({
  hasValidCookies: vi.fn(() => false),
  storeCookies: vi.fn(),
  // ensureCookieSession reads the row to tell "never connected" from "expired".
  getCookies: vi.fn(async () => null),
  isCookieExpired: vi.fn(() => true),
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

vi.mock("../src/auth/curl-session", () => ({
  signCurlToken: vi.fn(async () => "curl-jwt"),
}));

vi.mock("../src/telemetry/tracing", () => ({
  withSpan: vi.fn((_name: string, fn: Function) => fn()),
}));

vi.mock("../src/vault/store", () => ({
  // "longpw" is deliberately >= 8 chars so recent-values tests exercise the
  // substring-eligible ring path rather than the short-value whole-only guard
  // ("pw" -> "hunter2" is only 7 chars and would hit that guard once
  // remembered in the ring).
  readSecretValue: vi.fn(async (_u: string, name: string) =>
    name === "pw" ? "hunter2" : name === "port" ? "5432" : name === "longpw" ? "hunter2-long-value" : null
  ),
  touchUsed: vi.fn(async () => undefined),
}));

function findTool(name: string) {
  return metaTools.find((t) => t.name === name)!;
}

describe("meta-tools", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { _resetForTest } = await import("../src/vault/recent");
    _resetForTest();
  });

  describe("search_tools", () => {
    it("returns matching tools with a score", async () => {
      vi.spyOn(registry, "listTools").mockReturnValue([mockTool as any]);
      const tool = findTool("search_tools");
      const result = await tool.handler({ userId: "user-1" }, { query: "test" });
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]).toMatchObject({ name: "test_tool", integration: "test-integ" });
      expect(result.tools[0].score).toBeGreaterThan(0);
    });

    it("ranks built-in and custom-app tools together, and applies limit", async () => {
      const { ensureIndex } = await import("../src/custom-apps/index");
      vi.mocked(ensureIndex).mockResolvedValueOnce([
        { name: "linear__create_issue", description: "Create a Linear issue", integration: "custom:1" } as any,
      ]);
      vi.spyOn(registry, "listTools").mockReturnValue([
        { ...mockTool, name: "jira_create_issue", description: "Create a Jira issue" } as any,
        { ...mockTool, name: "jira_get_issue", description: "Get a Jira issue" } as any,
      ]);
      const tool = findTool("search_tools");

      const linear = await tool.handler({ userId: "user-1" }, { query: "create linear issue" });
      expect(linear.tools[0].name).toBe("linear__create_issue");

      const limited = await tool.handler({ userId: "user-1" }, { query: "issue", limit: 1 });
      expect(limited.tools).toHaveLength(1);
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
      // The audit row records that the tool ran, never what it ran with.
      const { auditLogger } = await import("../src/audit/logger");
      for (const call of vi.mocked(auditLogger.log).mock.calls) {
        expect(JSON.stringify(call)).not.toContain("hunter2");
      }
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

    it("scrubs the secret out of an INVALID_ARGS zod message", async () => {
      const { z } = await import("zod");
      const t = {
        name: "mode_tool",
        integration: "test-integ",
        inputSchema: z.object({ mode: z.enum(["a", "b"]) }),
        handler: vi.fn(),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), {
        tool: "mode_tool",
        args: { mode: "{{vault:pw}}" },
      });
      expect(result.error).not.toContain("hunter2");
      expect(result.error).toContain("{{vault:pw}}");
      expect(t.handler).not.toHaveBeenCalled();
    });

    it("fails closed when the handler result can't be scrubbed", async () => {
      const { z } = await import("zod");
      const t = {
        name: "unscrubbable",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async () => ({ big: 1n })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), {
        tool: "unscrubbable",
        args: { text: "{{vault:pw}}" },
      });
      expect(result.error).toBe("VAULT_SCRUB_FAILED");
      // A fail-closed scrub is a failed tool call and must be as observable as
      // any other one, or the only signal is the model's own error text.
      const { auditLogger } = await import("../src/audit/logger");
      expect(auditLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, error: "VAULT_SCRUB_FAILED", tool: "unscrubbable" })
      );
    });

    it("scrubs a value substituted in an earlier call from a later call's result that never referenced it", async () => {
      const { z } = await import("zod");
      const { _setNowForTest } = await import("../src/vault/recent");
      _setNowForTest(() => 1_000_000);
      const type = {
        name: "type",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ typed: a.text })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(type as any);
      await runOne(findTool("execute_tools"), { tool: "type", args: { text: "{{vault:longpw}}" } });

      const read = {
        name: "read",
        integration: "test-integ",
        inputSchema: z.object({}),
        handler: vi.fn(async () => ({ page: "login ok hunter2-long-value" })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(read as any);
      const result = await runOne(findTool("execute_tools"), { tool: "read", args: {} });
      expect(result.result).toEqual({ page: "login ok {{vault:longpw}}" });
    });

    it("scrubs a thrown error message in a later call using an earlier call's substituted value", async () => {
      const { z } = await import("zod");
      const { _setNowForTest } = await import("../src/vault/recent");
      _setNowForTest(() => 1_000_000);
      const type = {
        name: "type",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ typed: a.text })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(type as any);
      await runOne(findTool("execute_tools"), { tool: "type", args: { text: "{{vault:longpw}}" } });

      const boom = {
        name: "boom2",
        integration: "test-integ",
        inputSchema: z.object({}),
        handler: vi.fn(async () => {
          throw new Error("upstream saw hunter2-long-value in the page");
        }),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(boom as any);
      const result = await runOne(findTool("execute_tools"), { tool: "boom2", args: {} });
      expect(result.error).toBe("upstream saw {{vault:longpw}} in the page");
    });

    it("does not scrub a later call once the recent-values window has elapsed", async () => {
      const { z } = await import("zod");
      const { _setNowForTest, VAULT_RECENT_WINDOW_MS } = await import("../src/vault/recent");
      let t = 1_000_000;
      _setNowForTest(() => t);
      const type = {
        name: "type",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ typed: a.text })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(type as any);
      await runOne(findTool("execute_tools"), { tool: "type", args: { text: "{{vault:pw}}" } });

      t += VAULT_RECENT_WINDOW_MS + 1;
      const read = {
        name: "read",
        integration: "test-integ",
        inputSchema: z.object({}),
        handler: vi.fn(async () => ({ page: "login ok hunter2" })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(read as any);
      const result = await runOne(findTool("execute_tools"), { tool: "read", args: {} });
      expect(result.result).toEqual({ page: "login ok hunter2" });
    });

    it("does not scrub a different user's call with the current user's recently substituted value", async () => {
      const { z } = await import("zod");
      const { _setNowForTest } = await import("../src/vault/recent");
      _setNowForTest(() => 1_000_000);
      const type = {
        name: "type",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async (_c: unknown, a: { text: string }) => ({ typed: a.text })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(type as any);
      await runOne(findTool("execute_tools"), { tool: "type", args: { text: "{{vault:pw}}" } });

      const read = {
        name: "read",
        integration: "test-integ",
        inputSchema: z.object({}),
        handler: vi.fn(async () => ({ page: "login ok hunter2" })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(read as any);
      const result = await findTool("execute_tools")
        .handler({ userId: "user-2" }, { executions: [{ tool: "read", args: {} }] })
        .then((r: any) => r.results[0]);
      expect(result.result).toEqual({ page: "login ok hunter2" });
    });

    it("scrubs the current call's value over a stale ring value for the same name; the short stale value only scrubs where it is the whole string", async () => {
      const { z } = await import("zod");
      const { rememberSubstituted, _setNowForTest } = await import("../src/vault/recent");
      const { readSecretValue } = await import("../src/vault/store");
      _setNowForTest(() => 1_000_000);
      rememberSubstituted("user-1", new Map([["pw", "abc"]]));
      vi.mocked(readSecretValue).mockImplementationOnce(async (_u: string, name: string) =>
        name === "pw" ? "abcdef" : null
      );

      const t = {
        name: "echo2",
        integration: "test-integ",
        inputSchema: z.object({ text: z.string() }),
        handler: vi.fn(async () => ({ page: "value now abcdef, was abc" })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(t as any);
      const result = await runOne(findTool("execute_tools"), {
        tool: "echo2",
        args: { text: "{{vault:pw}}" },
      });
      // "abcdef" is this call's own substitution — always scrubbed, wherever
      // it appears. "abc" is a stale ring value under the 8-char guard, so it
      // only scrubs when it IS the whole string, not embedded in prose —
      // left alone here, and no plaintext of "abcdef" survives either.
      expect(result.result).toEqual({ page: "value now {{vault:pw}}, was abc" });
    });

    it("short-value guard: a ring value under 8 chars only scrubs a whole leaf, never inside prose; an 8+ char ring value still substring-scrubs", async () => {
      const { z } = await import("zod");
      const { rememberSubstituted, _setNowForTest } = await import("../src/vault/recent");
      _setNowForTest(() => 1_000_000);
      rememberSubstituted("user-1", new Map([["pin", "12"], ["longpw", "hunter2-long-value"]]));

      const read = {
        name: "read2",
        integration: "test-integ",
        inputSchema: z.object({}),
        handler: vi.fn(async () => ({
          n: 12,
          s: "there are 12 items",
          t: "12",
          u: "value is hunter2-long-value here",
        })),
      };
      vi.spyOn(registry, "getTool").mockReturnValue(read as any);
      const result = await runOne(findTool("execute_tools"), { tool: "read2", args: {} });
      expect(result.result).toEqual({
        n: "{{vault:pin}}",
        s: "there are 12 items",
        t: "{{vault:pin}}",
        u: "value is {{vault:longpw}} here",
      });
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
      // Real listCustomApps reads the shared DB; start from none.
      const { db } = await import("../src/db");
      await db.run("DELETE FROM custom_apps");
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

  describe("curl_session", () => {
    const mockProxyInteg = { ...mockOauthInteg, proxy: { baseUrl: "https://api.example.com" } };
    const schema = () => findTool("curl_session").inputSchema;

    beforeEach(async () => {
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockProxyInteg as any);
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" } as any);
    });

    it("defaults the token lifetime to 900 seconds", async () => {
      const args = schema().parse({ integrations: ["test-integ"] });
      expect(args.expiresInSeconds).toBe(900);
      const result: any = await findTool("curl_session").handler({ userId: "user-1" }, args);
      const { signCurlToken } = await import("../src/auth/curl-session");
      expect(signCurlToken).toHaveBeenCalledWith("user-1", ["test-integ"], 900);
      expect(result.expiresIn).toBe(900);
    });

    it.each([60, 300, 3600])("mints with an overridden lifetime of %i seconds", async (ttl) => {
      const args = schema().parse({ integrations: ["test-integ"], expiresInSeconds: ttl });
      const result: any = await findTool("curl_session").handler({ userId: "user-1" }, args);
      const { signCurlToken } = await import("../src/auth/curl-session");
      expect(signCurlToken).toHaveBeenCalledWith("user-1", ["test-integ"], ttl);
      expect(result.expiresIn).toBe(ttl);
    });

    it.each([0, -1, 59, 3601, 90.5])("rejects a lifetime of %s", (ttl) => {
      expect(schema().safeParse({ integrations: ["test-integ"], expiresInSeconds: ttl }).success).toBe(false);
    });

    it("advertises the lifetime bounds on the wire schema", async () => {
      const { metaToolSchemas } = await import("../src/mcp/meta-tools");
      const prop: any = (metaToolSchemas.curl_session as any).properties.expiresInSeconds;
      expect(prop).toMatchObject({ type: "integer", minimum: 60, maximum: 3600, default: 900 });
    });
  });

  describe("execute_tools compose", () => {
    const src = {
      name: "src_tool",
      integration: "test-integ",
      inputSchema: z.object({ q: z.string() }),
      handler: vi.fn(),
    };
    const dest = {
      name: "dest_tool",
      integration: "test-integ",
      inputSchema: z.object({
        body: z.string(),
        title: z.string().optional(),
        nested: z.object({ n: z.number() }).optional(),
      }),
      handler: vi.fn(),
    };
    const third = {
      name: "third_tool",
      integration: "test-integ",
      inputSchema: z.object({ id: z.string() }),
      handler: vi.fn(),
    };

    function stubComposeTools() {
      vi.spyOn(registry, "getTool").mockImplementation((name: string) => {
        if (name === "src_tool") return src as any;
        if (name === "dest_tool") return dest as any;
        if (name === "third_tool") return third as any;
        return undefined;
      });
      vi.spyOn(registry, "getIntegration").mockReturnValue(mockOauthInteg as any);
    }

    // Through the schema first, exactly as /mcp parses before the handler.
    const run = (input: Record<string, unknown>): Promise<any> => {
      const t = findTool("execute_tools");
      return t.handler({ userId: "user-1" }, t.inputSchema.parse(input) as any);
    };
    const compose = (executions: unknown[], ret: unknown): Promise<any> =>
      run({ compose: true, executions, return: ret });
    const schemaError = (input: Record<string, unknown>): string => {
      const parsed = findTool("execute_tools").inputSchema.safeParse(input);
      expect(parsed.success).toBe(false);
      return parsed.success ? "" : parsed.error.message;
    };

    beforeEach(async () => {
      const { getToken } = await import("../src/auth/tokens");
      vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" });
      src.handler.mockReset();
      dest.handler.mockReset();
      third.handler.mockReset();
    });

    it("pipes {{step:id.field}} into the next tool and returns only the return template", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "a,b\n1,2", filename: "out.csv", row_count: 1 });
      dest.handler.mockResolvedValue({ id: "file-1", name: "out.csv" });

      const result = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:a.csv}}", title: "{{step:a.filename}}" } },
        ],
        { file_id: "{{step:b.id}}", rows: "{{step:a.row_count}}" }
      );
      expect(dest.handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "a,b\n1,2", title: "out.csv" })
      );
      expect(result).toEqual({ result: { file_id: "file-1", rows: 1 } });
      expect(JSON.stringify(result)).not.toContain("a,b");
    });

    it("keeps the original type for a whole-value ref and chains three steps", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ n: 7 });
      dest.handler.mockResolvedValue({ id: "mid-1" });
      third.handler.mockResolvedValue({ ok: true });

      const result = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "n", nested: { n: "{{step:a.n}}" } } },
          { ref_id: "c", tool: "third_tool", args: { id: "{{step:b.id}}" } },
        ],
        "{{step:c.ok}}"
      );
      expect(dest.handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ nested: { n: 7 } })
      );
      expect(third.handler).toHaveBeenCalledWith(expect.anything(), { id: "mid-1" });
      expect(result).toEqual({ result: true });
    });

    it("interpolates refs embedded in a larger string", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ title: "Fix bug", count: 3 });
      dest.handler.mockResolvedValue({ id: "m-1" });

      await compose(
        [
          { ref_id: "pr", tool: "src_tool", args: { q: "x" } },
          { ref_id: "msg", tool: "dest_tool", args: { body: "Review: {{step:pr.title}} ({{step:pr.count}} files)" } },
        ],
        "{{step:msg.id}}"
      );
      expect(dest.handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "Review: Fix bug (3 files)" })
      );
    });

    it("resolves numeric segments into arrays", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ files: [{ id: "f-0" }, { id: "f-1" }] });
      third.handler.mockResolvedValue({ ok: true });

      const result = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "third_tool", args: { id: "{{step:a.files.1.id}}" } },
        ],
        ["{{step:a.files.0.id}}", "{{step:b.ok}}"]
      );
      expect(third.handler).toHaveBeenCalledWith(expect.anything(), { id: "f-1" });
      expect(result).toEqual({ result: ["f-0", true] });
    });

    it("stops on the first step error, names the step, and runs nothing after it", async () => {
      stubComposeTools();
      src.handler.mockRejectedValue(new Error("src failed"));

      const result = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:a.csv}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(result.error).toMatch(/src failed/);
      expect(result.ref_id).toBe("a");
      expect(dest.handler).not.toHaveBeenCalled();
    });

    it("returns BAD_REF for an unknown step or a missing field", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "x" });

      const missingField = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:a.nope}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(missingField.error).toMatch(/BAD_REF/);
      expect(missingField.ref_id).toBe("b");
      expect(dest.handler).not.toHaveBeenCalled();

      const unknownStep = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:z.csv}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(unknownStep.error).toMatch(/BAD_REF/);
    });

    it.each(["constructor", "__proto__", "toString", "files.0.hasOwnProperty"])(
      "treats inherited key '%s' as missing, not as a value",
      async (path) => {
        stubComposeTools();
        src.handler.mockResolvedValue({ files: [{ id: "f-0" }] });

        const result = await compose(
          [
            { ref_id: "a", tool: "src_tool", args: { q: "x" } },
            { ref_id: "b", tool: "dest_tool", args: { body: `{{step:a.${path}}}` } },
          ],
          "{{step:b.id}}"
        );
        expect(result.error).toMatch(/BAD_REF: missing/);
        expect(dest.handler).not.toHaveBeenCalled();
      }
    );

    it("rejects a malformed {{step:...}} instead of passing it through as a literal", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "x" });

      const result = await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:a.csv.}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(result.error).toMatch(/BAD_REF/);
      expect(dest.handler).not.toHaveBeenCalled();
    });

    it("returns BAD_REF when the return template points at a missing field", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "x" });

      const result = await compose([{ ref_id: "a", tool: "src_tool", args: { q: "x" } }], "{{step:a.nope}}");
      expect(result.error).toMatch(/BAD_REF/);
    });

    it("rejects duplicate ref_ids at the schema, before running anything", () => {
      const msg = schemaError({
        compose: true,
        executions: [
          { ref_id: "a", tool: "src_tool" },
          { ref_id: "a", tool: "src_tool" },
        ],
      });
      expect(msg).toMatch(/Duplicate ref_id 'a'/);
    });

    it.each(["1a", "a-b", "a.b", "", "x".repeat(65)])("rejects invalid ref_id %j at the schema", (refId) => {
      expect(schemaError({ compose: true, executions: [{ ref_id: refId, tool: "src_tool" }] })).toMatch(/ref_id/);
    });

    it("requires ref_id on every execution with compose: true", () => {
      expect(schemaError({ compose: true, executions: [{ tool: "src_tool" }] })).toMatch(/ref_id is required/);
    });

    it("rejects ref_id when neither compose nor return would use it", () => {
      expect(schemaError({ executions: [{ ref_id: "a", tool: "src_tool" }] })).toMatch(
        /ref_id is only used with compose or return/
      );
    });

    it("caps compose at 8 executions", () => {
      const executions = Array.from({ length: 9 }, (_, i) => ({ ref_id: `s${i}`, tool: "src_tool" }));
      expect(schemaError({ compose: true, executions })).toMatch(/at most 8/);
      expect(findTool("execute_tools").inputSchema.safeParse({ compose: true, executions: executions.slice(0, 8) }).success).toBe(true);
    });

    it("does not cap a plain batch at 8", () => {
      const executions = Array.from({ length: 9 }, () => ({ tool: "src_tool" }));
      expect(findTool("execute_tools").inputSchema.safeParse({ executions }).success).toBe(true);
    });

    it("advertises the ref_id constraints in the JSON schema", async () => {
      const { metaToolSchemas } = await import("../src/mcp/meta-tools");
      const refId = (metaToolSchemas.execute_tools as any).properties.executions.items.properties.ref_id;
      expect(refId.pattern).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
      expect(refId.maxLength).toBe(64);
    });

    it("compose without return answers with the last step's result", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ n: 7 });
      dest.handler.mockResolvedValue({ id: "mid-1" });

      const result = await run({
        compose: true,
        executions: [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "n={{step:a.n}}" } },
        ],
      });
      expect(result).toEqual({ result: { id: "mid-1" } });
    });

    it("return without compose projects over a concurrent batch", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "a,b\n1,2", row_count: 1 });
      third.handler.mockResolvedValue({ ok: true });

      const result = await run({
        executions: [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "c", tool: "third_tool", args: { id: "z" } },
        ],
        return: { rows: "{{step:a.row_count}}", ok: "{{step:c.ok}}" },
      });
      expect(result).toEqual({ result: { rows: 1, ok: true } });
      expect(JSON.stringify(result)).not.toContain("a,b");
    });

    it("return without compose does not interpolate between executions", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ csv: "x" });
      third.handler.mockResolvedValue({ ok: true });

      await run({
        executions: [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "c", tool: "third_tool", args: { id: "{{step:a.csv}}" } },
        ],
        return: "{{step:c.ok}}",
      });
      expect(third.handler).toHaveBeenCalledWith(expect.anything(), { id: "{{step:a.csv}}" });
    });

    it("return without compose reports failed executions instead of dropping them", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ row_count: 1 });
      third.handler.mockRejectedValue(new Error("third failed"));

      const ok = await run({
        executions: [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "c", tool: "third_tool", args: { id: "z" } },
        ],
        return: "{{step:a.row_count}}",
      });
      expect(ok.result).toBe(1);
      expect(ok.errors).toEqual([expect.objectContaining({ index: 1, ref_id: "c", error: expect.stringMatching(/third failed/) })]);

      const bad = await run({
        executions: [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "c", tool: "third_tool", args: { id: "z" } },
        ],
        return: "{{step:c.ok}}",
      });
      expect(bad.error).toMatch(/BAD_REF/);
      expect(bad.errors).toHaveLength(1);
    });

    it("substitutes {{vault:...}} written by the agent in a compose step", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ id: "a-1" });
      dest.handler.mockResolvedValue({ id: "b-1" });

      await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "Bearer {{vault:pw}} for {{step:a.id}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(dest.handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "Bearer hunter2 for a-1" })
      );
    });

    it("never resolves a {{vault:...}} that arrived inside an earlier step's output", async () => {
      stubComposeTools();
      // Attacker-controlled upstream text (a PR title, a CSV cell) that looks
      // like a vault reference must reach the next tool as literal text.
      src.handler.mockResolvedValue({ title: "{{vault:pw}}" });
      dest.handler.mockResolvedValue({ id: "b-1" });

      await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "dest_tool", args: { body: "{{step:a.title}}", title: "t: {{step:a.title}}" } },
        ],
        "{{step:b.id}}"
      );
      expect(dest.handler).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ body: "{{vault:pw}}", title: "t: {{vault:pw}}" })
      );
      const { readSecretValue } = await import("../src/vault/store");
      expect(readSecretValue).not.toHaveBeenCalled();
    });

    it("does not resolve {{vault:...}} in the return template", async () => {
      stubComposeTools();
      src.handler.mockResolvedValue({ id: "a-1" });

      const result = await compose(
        [{ ref_id: "a", tool: "src_tool", args: { q: "x" } }],
        { id: "{{step:a.id}}", leak: "{{vault:pw}}" }
      );
      expect(result).toEqual({ result: { id: "a-1", leak: "{{vault:pw}}" } });
    });

    it("never resolves a {{vault:...}} from an earlier step's output in a custom-app step", async () => {
      stubComposeTools();
      const appIndex = await import("../src/custom-apps/index");
      const store = await import("../src/custom-apps/store");
      const oauth = await import("../src/custom-apps/oauth");
      const client = await import("../src/custom-apps/client");
      vi.spyOn(appIndex, "getToolForUser").mockImplementation(async (_u: string, name: string) =>
        name === "remote__echo"
          ? ({ name: "remote__echo", remoteName: "echo", appId: "app-1", integration: "custom:app-1" } as any)
          : undefined
      );
      vi.spyOn(store, "getCustomApp").mockResolvedValue({ id: "app-1", baseUrl: "https://mcp.example.com" } as any);
      vi.spyOn(oauth, "ensureCustomAppToken").mockResolvedValue("tok-abc");
      const remote = vi.spyOn(client, "callRemoteTool").mockResolvedValue({ content: [] } as any);
      src.handler.mockResolvedValue({ title: "{{vault:pw}}" });

      await compose(
        [
          { ref_id: "a", tool: "src_tool", args: { q: "x" } },
          { ref_id: "b", tool: "remote__echo", args: { text: "{{step:a.title}}" } },
        ],
        "{{step:b}}"
      );
      expect(remote).toHaveBeenCalledWith(
        "user-1", "https://mcp.example.com", { Authorization: "Bearer tok-abc" }, "echo", { text: "{{vault:pw}}" }
      );
      const { readSecretValue } = await import("../src/vault/store");
      expect(readSecretValue).not.toHaveBeenCalled();
    });

    it("substitutes {{vault:...}} the agent wrote in a custom-app step", async () => {
      stubComposeTools();
      const appIndex = await import("../src/custom-apps/index");
      const store = await import("../src/custom-apps/store");
      const oauth = await import("../src/custom-apps/oauth");
      const client = await import("../src/custom-apps/client");
      vi.spyOn(appIndex, "getToolForUser").mockResolvedValue(
        { name: "remote__echo", remoteName: "echo", appId: "app-1", integration: "custom:app-1" } as any
      );
      vi.spyOn(store, "getCustomApp").mockResolvedValue({ id: "app-1", baseUrl: "https://mcp.example.com" } as any);
      vi.spyOn(oauth, "ensureCustomAppToken").mockResolvedValue("tok-abc");
      const remote = vi
        .spyOn(client, "callRemoteTool")
        .mockResolvedValue({ content: [{ type: "text", text: "echo hunter2" }] } as any);

      const result = await compose(
        [{ ref_id: "b", tool: "remote__echo", args: { text: "Bearer {{vault:pw}}" } }],
        "{{step:b}}"
      );
      expect(remote).toHaveBeenCalledWith(
        "user-1", "https://mcp.example.com", { Authorization: "Bearer tok-abc" }, "echo", { text: "Bearer hunter2" }
      );
      expect(JSON.stringify(result)).not.toContain("hunter2");
    });
  });

  describe("headers custom app execution", () => {
    const SECRET = "tok-abc-secret-value";
    const headersApp = {
      id: "app-h", userId: "user-1", name: "keyed", baseUrl: "https://mcp.example.com/mcp",
      metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: SECRET }],
    };
    const tool = { name: "keyed__echo", remoteName: "echo", appId: "app-h", integration: "custom:app-h" } as any;

    async function setup() {
      const store = await import("../src/custom-apps/store");
      const client = await import("../src/custom-apps/client");
      const { auditLogger } = await import("../src/audit/logger");
      vi.spyOn(store, "getCustomApp").mockResolvedValue(headersApp as any);
      vi.mocked(auditLogger.log).mockClear();
      return { client, auditLogger };
    }

    it("sends the stored headers record to callRemoteTool", async () => {
      const { client } = await setup();
      const remote = vi.spyOn(client, "callRemoteTool").mockResolvedValue({ content: [{ type: "text", text: "ok" }] } as any);
      const { executeCustomAppSingle } = await import("../src/mcp/meta-tools");
      const res = await executeCustomAppSingle("user-1", tool, { a: 1 });
      expect(res).toHaveProperty("result");
      expect(remote).toHaveBeenCalledWith("user-1", "https://mcp.example.com/mcp", { "X-Api-Key": SECRET }, "echo", { a: 1 });
    });

    it("an upstream 401 yields the check-the-headers hint without the value", async () => {
      const { client, auditLogger } = await setup();
      const { StreamableHTTPError } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      vi.spyOn(client, "callRemoteTool").mockRejectedValue(new StreamableHTTPError(401, `denied ${SECRET}`));
      const { executeCustomAppSingle } = await import("../src/mcp/meta-tools");
      const res = (await executeCustomAppSingle("user-1", tool, {})) as { error: string };
      expect(res.error).toContain("check the app's headers");
      expect(JSON.stringify(res)).not.toContain(SECRET);
      expect(JSON.stringify(vi.mocked(auditLogger.log).mock.calls)).not.toContain(SECRET);
    });

    it("redacts header values echoed in a non-auth call-time error, in result and audit log", async () => {
      const { client, auditLogger } = await setup();
      vi.spyOn(client, "callRemoteTool").mockRejectedValue(new Error(`upstream 500: request had X-Api-Key: ${SECRET}`));
      const { executeCustomAppSingle } = await import("../src/mcp/meta-tools");
      const res = (await executeCustomAppSingle("user-1", tool, {})) as { error: string };
      expect(res.error).toContain("[redacted]");
      expect(res.error).not.toContain(SECRET);
      const audit = JSON.stringify(vi.mocked(auditLogger.log).mock.calls);
      expect(audit).toContain("[redacted]");
      expect(audit).not.toContain(SECRET);
    });

    it("redacts header values echoed in an isError result", async () => {
      const { client, auditLogger } = await setup();
      vi.spyOn(client, "callRemoteTool").mockResolvedValue({ isError: true, content: [{ type: "text", text: `bad ${SECRET}` }] } as any);
      const { executeCustomAppSingle } = await import("../src/mcp/meta-tools");
      const res = (await executeCustomAppSingle("user-1", tool, {})) as { error: string };
      expect(res.error).toBe("bad [redacted]");
      expect(JSON.stringify(vi.mocked(auditLogger.log).mock.calls)).not.toContain(SECRET);
    });
  });
});
