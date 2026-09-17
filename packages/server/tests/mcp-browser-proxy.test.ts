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

import { config } from "../src/config";
import { SESSION_HEADER, mintSessionKey } from "../src/auth/cdp-bridge";
import { forwardForBrowserAffinity, touchesBrowser } from "../src/auth/affinity-forward";

// A trimmed /mcp: authenticate (stubbed), then the helper under test, then a
// local marker so the test can tell "handled here" from "forwarded".
async function buildApp() {
  const app = Fastify({ logger: false });
  app.post("/mcp", async (request, reply) => {
    const userId = request.headers["x-workbench-api-key"] === "valid-key" ? "user-1" : null;
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });
    const body = request.body as Record<string, unknown>;
    const params = body.params as { name?: unknown; arguments?: { executions?: unknown } } | undefined;
    if (
      body.method === "tools/call" &&
      touchesBrowser(params?.arguments?.executions, params?.name)
    ) {
      const sent = await forwardForBrowserAffinity({
        userId, request, reply, target: config.INTERNAL_MCP_URL!, body,
      });
      if (sent) return reply;
    }
    return { jsonrpc: "2.0", id: 1, result: { local: true } };
  });
  await app.ready();
  return app;
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function wrapped(tool: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "execute_tools", arguments: { executions: [{ tool, args }] } },
  };
}

describe("touchesBrowser", () => {
  it("is true for any browser_* execution, with or without a session_id", () => {
    expect(touchesBrowser([{ tool: "browser_navigate", args: { url: "https://example.com" } }])).toBe(true);
    expect(touchesBrowser([{ tool: "github_list_repos", args: {} }, { tool: "browser_start", args: {} }])).toBe(true);
  });
  it("is false for non-browser tools even when an arg is named session_id", () => {
    expect(touchesBrowser([{ tool: "github_list_repos", args: { session_id: "x" } }])).toBe(false);
    expect(touchesBrowser(undefined)).toBe(false);
    expect(touchesBrowser("not-a-list")).toBe(false);
  });
  it("is true for a direct browser_* tools/call", () => {
    expect(touchesBrowser(undefined, "browser_start")).toBe(true);
    expect(touchesBrowser(undefined, "execute_tools")).toBe(false);
  });
});

describe("browser affinity forward", () => {
  it("forwards a wrapped browser_* call with the user's routing key, derived from the bearer", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { remote: true } }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { remote: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/mcp");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(init.headers["x-workbench-api-key"]).toBe("valid-key");
    await app.close();
  });

  it("never reads a session_id from the args: an agent-supplied value is ignored", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ ok: 1 }) });
    const app = await buildApp();
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_click", { session_id: "attacker-chosen", x: 1, y: 1 }),
    });
    expect(fetchMock.mock.calls[0][1].headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    await app.close();
  });

  it("forwards a direct browser_start tools/call (no execute_tools wrapper)", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ ok: 1 }) });
    const app = await buildApp();
    await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_start", arguments: {} } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("handles a non-browser call locally", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("github_list_repos", { session_id: "x" }),
    });
    expect(res.json().result).toEqual({ local: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not re-forward a request carrying this user's own key (the receiving replica)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        "x-workbench-api-key": "valid-key",
        "content-type": "application/json",
        [SESSION_HEADER]: mintSessionKey("user-1"),
      },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.json().result).toEqual({ local: true });
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("forwards anyway when the inbound header does not verify, with the correct key", async () => {
    // An agent-chosen value must not suppress forwarding: the mesh would hash
    // it onto an arbitrary replica, which would spawn a second chromium on the
    // shared profile and fight the owner for SingletonLock.
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ result: { forwarded: true } }) });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: {
        "x-workbench-api-key": "valid-key",
        "content-type": "application/json",
        [SESSION_HEADER]: "not-a-real-key",
      },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.json()).toEqual({ result: { forwarded: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    await app.close();
  });

  it("falls through to local handling on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.json().result).toEqual({ local: true });
    await app.close();
  });

  it("maps an empty upstream body to 202", async () => {
    fetchMock.mockResolvedValue({ status: 202, text: async () => "" });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST", url: "/mcp",
      headers: { "x-workbench-api-key": "valid-key", "content-type": "application/json" },
      payload: wrapped("browser_navigate", { url: "https://example.com" }),
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
