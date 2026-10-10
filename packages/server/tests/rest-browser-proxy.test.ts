import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: {
    PORTAL_URL: "http://portal.test",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    CONNECT_TTL_SECONDS: 600,
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    INTERNAL_MCP_URL: "http://a-workbench/mcp",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));
vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(() => ({ userId: "user-1", getToken: vi.fn(), http: vi.fn() })),
}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: vi.fn(() => Promise.resolve()) } }));
vi.mock("../src/auth/tokens", () => ({ getToken: vi.fn() }));
vi.mock("../src/auth/users", () => ({ getUserById: vi.fn(), verifyApiKey: vi.fn() }));
vi.mock("../src/auth/cookie", () => ({ hasValidCookies: vi.fn(() => false), storeCookies: vi.fn() }));
vi.mock("../src/auth/connections", () => ({ createPending: vi.fn(), getPending: vi.fn(), reapOne: vi.fn() }));
vi.mock("../src/auth/connect-token", () => ({ signConnectToken: vi.fn() }));
vi.mock("../src/auth/curl-session", () => ({ signCurlToken: vi.fn() }));
vi.mock("../src/telemetry/tracing", () => ({ withSpan: vi.fn((_n: string, fn: Function) => fn()) }));
vi.mock("../src/vault/store", () => ({ readSecretValue: vi.fn(async () => null), touchUsed: vi.fn(async () => undefined) }));
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers["x-workbench-api-key"] === "valid-api-key" ? "user-1" : null
  ),
}));

import { registerRestRoutes } from "../src/api/rest-routes";
import { registry } from "../src/plugins/registry";
import { hasValidCookies } from "../src/auth/cookie";
import { SESSION_HEADER, mintSessionKey } from "../src/auth/cdp-bridge";

const browserInteg = {
  name: "browser",
  version: "1.0.0",
  displayName: "Browser",
  auth: { type: "none" as const },
};
const githubInteg = {
  name: "github",
  version: "1.0.0",
  displayName: "GitHub",
  auth: { type: "none" as const },
};

const browserStart = {
  name: "browser_start",
  description: "start",
  integration: "browser",
  inputSchema: z.object({}),
  handler: vi.fn(async () => ({ session_id: "local-tab" })),
};
const listRepos = {
  name: "github_list_repos",
  description: "List repos",
  integration: "github",
  inputSchema: z.object({}),
  handler: vi.fn(async () => ({ local: true })),
};

const acmeInteg = {
  name: "acme",
  version: "1.0.0",
  displayName: "Acme",
  auth: { type: "cookie" as const, reconnect: { steps: [{ goto: "loginUrl" }] } },
};
const acmeList = {
  name: "acme_list",
  description: "list",
  integration: "acme",
  inputSchema: z.object({}),
  handler: vi.fn(async () => ({ local: true })),
};

function stubRegistry() {
  vi.spyOn(registry, "getIntegration").mockImplementation((name: string) =>
    name === "browser" ? (browserInteg as any) : name === "github" ? (githubInteg as any) : name === "acme" ? (acmeInteg as any) : undefined
  );
  vi.spyOn(registry, "listToolsByIntegration").mockImplementation((name: string) =>
    name === "browser" ? ([browserStart] as any) : name === "github" ? ([listRepos] as any) : name === "acme" ? ([acmeList] as any) : []
  );
  vi.spyOn(registry, "getTool").mockImplementation((name: string) => {
    if (name === "browser_start") return browserStart as any;
    if (name === "github_list_repos") return listRepos as any;
    if (name === "acme_list") return acmeList as any;
    return undefined;
  });
}

const fetchMock = vi.fn();
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  stubRegistry();
  app = Fastify({ logger: false });
  await registerRestRoutes(app as any);
  await app.ready();
});
afterEach(async () => { vi.unstubAllGlobals(); await app.close(); });

const headers = { "x-workbench-api-key": "valid-api-key", "content-type": "application/json" };

describe("POST /rest/browser affinity", () => {
  it("forwards to /rest/browser on the internal origin with the user's routing key", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ integration: "browser", result: { session_id: "remote-tab" } }) });
    const res = await app.inject({ method: "POST", url: "/rest/browser", headers, payload: { tool: "start" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ integration: "browser", result: { session_id: "remote-tab" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/rest/browser");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(browserStart.handler).not.toHaveBeenCalled();
  });

  it("does not forward another integration", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/github", headers, payload: { tool: "list_repos" } });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles locally when the header carries this user's own key", async () => {
    const res = await app.inject({
      method: "POST", url: "/rest/browser",
      headers: { ...headers, [SESSION_HEADER]: mintSessionKey("user-1") },
      payload: { tool: "start" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(browserStart.handler).toHaveBeenCalled();
  });

  it("forwards anyway when the inbound header does not verify, with the correct key", async () => {
    // A value the agent chose must not suppress forwarding — see the comment
    // in affinity-forward.ts.
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ integration: "browser", result: {} }) });
    const res = await app.inject({
      method: "POST", url: "/rest/browser",
      headers: { ...headers, [SESSION_HEADER]: "not-a-real-key" },
      payload: { tool: "start" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
  });
});

describe("POST /rest/<recipe integration> affinity", () => {
  it("forwards to its own path with the user's routing key", async () => {
    fetchMock.mockResolvedValue({ status: 200, text: async () => JSON.stringify({ integration: "acme", result: { remote: true } }) });
    const res = await app.inject({ method: "POST", url: "/rest/acme", headers, payload: { tool: "list" } });
    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://a-workbench/rest/acme");
    expect(init.headers[SESSION_HEADER]).toBe(mintSessionKey("user-1"));
    expect(acmeList.handler).not.toHaveBeenCalled();
  });

  it("handles locally when the header carries this user's own key", async () => {
    vi.mocked(hasValidCookies).mockResolvedValueOnce(true as never);
    const res = await app.inject({
      method: "POST", url: "/rest/acme",
      headers: { ...headers, [SESSION_HEADER]: mintSessionKey("user-1") },
      payload: { tool: "list" },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(acmeList.handler).toHaveBeenCalled();
  });
});
