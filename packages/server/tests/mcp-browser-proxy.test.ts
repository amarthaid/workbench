import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

// Minimal config — only the fields the proxy block reads.
vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    INTERNAL_MCP_URL: "http://a-workbench/mcp",
    NODE_ENV: "test",
    DATABASE_URL: "./data/tokens.db",
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers["x-workbench-api-key"] === "valid-key" ? "user-1" : null
  ),
}));

vi.mock("../src/mcp/server", () => ({
  handleMcpRequest: vi.fn(async () => ({ jsonrpc: "2.0", id: 1, result: { local: true } })),
}));

// Stub out everything index.ts transitively touches at module load time.
vi.mock("../src/db", () => ({ db: { close: vi.fn() } }));
vi.mock("../src/telemetry/tracing", () => ({}));
vi.mock("../src/telemetry/metrics", () => ({
  metricsRegistry: { contentType: "text/plain", metrics: vi.fn(async () => "") },
  httpRequestsTotal: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
}));

import { config } from "../src/config";
import { resolveMcpUser } from "../src/auth/oauth-server/resolve";
import { handleMcpRequest } from "../src/mcp/server";
import { SESSION_HEADER } from "../src/auth/cdp-bridge";

// Build a trimmed /mcp server that only contains the proxy block under test.
async function buildApp() {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, JSON.parse(body as string)); } catch (e) { done(e as Error); }
  });

  app.post("/mcp", async (request, reply) => {
    const userId = await resolveMcpUser(request.headers as Record<string, string>);
    if (!userId) return reply.status(401).send({ error: "Unauthorized" });

    const body = request.body as Record<string, unknown>;
    const sessionHeader = request.headers[SESSION_HEADER] as string | undefined;
    const callArgs = (body.params as Record<string, unknown> | undefined)?.arguments as Record<string, unknown> | undefined;
    const executions = Array.isArray(callArgs?.executions)
      ? (callArgs!.executions as { tool?: unknown; args?: Record<string, unknown> }[])
      : [];
    const sessionId: string | undefined =
      executions.find((e) => typeof e?.args?.session_id === "string")?.args?.session_id as string | undefined;

    if (config.INTERNAL_MCP_URL && !sessionHeader && body.method === "tools/call" && sessionId) {
      const fwdHeaders: Record<string, string> = {
        "content-type": "application/json",
        [SESSION_HEADER]: sessionId,
      };
      const auth = request.headers.authorization as string | undefined;
      if (auth) fwdHeaders.authorization = auth;
      const apiKey = request.headers["x-workbench-api-key"] as string | undefined;
      if (apiKey) fwdHeaders["x-workbench-api-key"] = apiKey;
      try {
        const res = await fetch(config.INTERNAL_MCP_URL!, {
          method: "POST",
          headers: fwdHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await res.text();
        if (res.status === 202 || !text) { reply.status(202).send(); return; }
        reply.status(res.status).send(JSON.parse(text) as Record<string, unknown>);
        return;
      } catch { /* fall through */ }
    }

    const result = await handleMcpRequest(body, userId);
    if (result === null) { reply.status(202).send(); return; }
    reply.send(result);
  });

  return app;
}

const AUTH = { "x-workbench-api-key": "valid-key" };
const ET_BODY = (sessionId?: string) => JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: {
    name: "execute_tools",
    arguments: {
      executions: [{ tool: "browser_navigate", args: { session_id: sessionId, url: "https://e.com" } }],
    },
  },
});

describe("/mcp browser proxy", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    app = await buildApp();
    fetchSpy = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { proxied: true } }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllGlobals();
  });

  it("proxies execute_tools call when session_id is in executions[i].args", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...AUTH, "content-type": "application/json" },
      body: ET_BODY("sess-abc"),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { proxied: true } });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://a-workbench/mcp");
    expect(opts.headers[SESSION_HEADER]).toBe("sess-abc");
    expect(opts.headers["x-workbench-api-key"]).toBe("valid-key");
  });

  it("does NOT proxy when X-Browser-Session header already present (loop prevention)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...AUTH, "content-type": "application/json", [SESSION_HEADER]: "sess-abc" },
      body: ET_BODY("sess-abc"),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { local: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT proxy when no session_id in any execution", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "execute_tools",
        arguments: {
          executions: [{ tool: "browser_navigate", args: { url: "https://e.com" } }],
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...AUTH, "content-type": "application/json" },
      body,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { local: true } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to local handling when proxy fetch throws", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...AUTH, "content-type": "application/json" },
      body: ET_BODY("sess-abc"),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ result: { local: true } });
  });
});
