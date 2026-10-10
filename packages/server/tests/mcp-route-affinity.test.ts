import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    INTERNAL_MCP_URL: "http://a-workbench/mcp",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

// What mayOwnBrowser() said while the real /mcp route handled the call.
const owned: boolean[] = [];
vi.mock("../src/mcp/server", async () => {
  const { mayOwnBrowser } = await import("../src/auth/reconnect/affinity");
  return {
    handleMcpRequest: vi.fn(async () => {
      owned.push(mayOwnBrowser());
      return { jsonrpc: "2.0", id: 1, result: { local: true } };
    }),
  };
});
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers["x-workbench-api-key"] === "valid-key" ? "user-1" : null
  ),
}));

import { registerMcpRoute } from "../src/mcp/route";
import { handleMcpRequest } from "../src/mcp/server";
import { registry } from "../src/plugins/registry";
import { config } from "../src/config";
import { SESSION_HEADER, mintSessionKey } from "../src/auth/cdp-bridge";

const fetchMock = vi.fn();
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  owned.length = 0;
  vi.mocked(handleMcpRequest).mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(registry, "getTool").mockImplementation((n: string) =>
    n === "acme_list" ? ({ integration: "acme" } as any) : n === "other_list" ? ({ integration: "other" } as any) : undefined);
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) =>
    n === "acme"
      ? ({ name: "acme", auth: { type: "cookie", reconnect: { steps: [{ goto: "loginUrl" }] } } } as any)
      : ({ name: n, auth: { type: "cookie" } } as any));
  app = Fastify({ logger: false });
  registerMcpRoute(app as any);
  await app.ready();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await app.close();
});

const headers = { "x-workbench-api-key": "valid-key", "content-type": "application/json" };
function call(tool: string) {
  return {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "execute_tools", arguments: { executions: [{ tool, args: {} }] } },
  };
}

describe("/mcp owner gate", () => {
  // When the hop fails the request falls through to local handling, which is
  // where the gate decides whether the handler may drive chromium.
  it("grants chromium ownership only for this user's verified key", async () => {
    fetchMock.mockRejectedValue(connRefused());
    for (const [key, expected] of [
      [mintSessionKey("user-1"), true],
      [undefined, false],
      [mintSessionKey("user-2"), false],
    ] as const) {
      owned.length = 0;
      const res = await app.inject({
        method: "POST", url: "/mcp",
        headers: key ? { ...headers, [SESSION_HEADER]: key } : headers,
        payload: call("acme_list"),
      });
      expect(res.statusCode).toBe(200);
      expect(owned).toEqual([expected]);
    }
  });

  it("forwards a recipe integration's tool with the user's routing key", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { remote: true } }) });
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: call("acme_list") });
    expect(res.json().result).toEqual({ remote: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/mcp");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it("a timeout after the request was sent is 504 UPSTREAM_TIMEOUT and never runs locally", async () => {
    // The owner may still be running the tool (a slow recipe). Running it here
    // too would duplicate its side effects.
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: call("acme_list") });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: "UPSTREAM_TIMEOUT" });
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it("connection refused (nothing sent) still falls back to local handling", async () => {
    fetchMock.mockRejectedValue(connRefused());
    const res = await app.inject({ method: "POST", url: "/mcp", headers, payload: call("acme_list") });
    expect(res.statusCode).toBe(200);
    expect(handleMcpRequest).toHaveBeenCalledTimes(1);
  });

  it("a recipe integration's call gets a 150s forward budget; a browser_* call keeps 30s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ result: {} }) });
    await app.inject({ method: "POST", url: "/mcp", headers, payload: call("acme_list") });
    expect(timeout).toHaveBeenLastCalledWith(150_000);
    await app.inject({ method: "POST", url: "/mcp", headers, payload: call("browser_navigate") });
    expect(timeout).toHaveBeenLastCalledWith(30_000);
  });

  it("forwards, rather than runs, another user's key", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ result: {} }) });
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { ...headers, [SESSION_HEADER]: mintSessionKey("user-2") },
      payload: call("acme_list"),
    });
    expect(fetchMock.mock.calls[0][1].headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  it("handles an integration without a recipe locally", async () => {
    await app.inject({ method: "POST", url: "/mcp", headers, payload: call("other_list") });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(owned).toEqual([false]);
  });

  it("single process: nothing forwards and ownership is implied", async () => {
    const saved = config.INTERNAL_MCP_URL;
    (config as any).INTERNAL_MCP_URL = undefined;
    try {
      await app.inject({ method: "POST", url: "/mcp", headers, payload: call("acme_list") });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(owned).toEqual([true]);
    } finally {
      (config as any).INTERNAL_MCP_URL = saved;
    }
  });
});

// What undici throws when the connect itself fails: nothing was sent.
function connRefused() {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED a-workbench:80"), { code: "ECONNREFUSED" }) });
}
