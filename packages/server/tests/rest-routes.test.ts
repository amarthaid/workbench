import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

vi.mock("../src/config", () => ({
  config: {
    PORTAL_URL: "http://portal.test",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    CONNECT_TTL_SECONDS: 600,
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(() => ({ userId: "user-1", getToken: vi.fn(), http: vi.fn() })),
}));

vi.mock("../src/audit/logger", () => ({
  auditLogger: { log: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../src/auth/tokens", () => ({ getToken: vi.fn() }));
vi.mock("../src/auth/users", () => ({ getUserById: vi.fn(), verifyApiKey: vi.fn() }));
vi.mock("../src/auth/cookie", () => ({ hasValidCookies: vi.fn(() => false), storeCookies: vi.fn() }));
vi.mock("../src/auth/connections", () => ({
  createPending: vi.fn(),
  getPending: vi.fn(),
  reapOne: vi.fn(),
}));
vi.mock("../src/auth/connect-token", () => ({ signConnectToken: vi.fn() }));
vi.mock("../src/auth/curl-session", () => ({ signCurlToken: vi.fn() }));
vi.mock("../src/telemetry/tracing", () => ({
  withSpan: vi.fn((_name: string, fn: Function) => fn()),
}));

vi.mock("../src/vault/store", () => ({
  readSecretValue: vi.fn(async () => null),
  touchUsed: vi.fn(async () => undefined),
}));

// The REST endpoint authenticates exactly like /mcp — resolveMcpUser is the
// shared resolver, stubbed here so the suite tests routing, not JWT crypto.
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (headers: Record<string, string>) =>
    headers["x-workbench-api-key"] === "valid-api-key" ? "user-1" : null
  ),
}));

import { registerRestRoutes } from "../src/api/rest-routes";
import { registry } from "../src/plugins/registry";
import { getToken } from "../src/auth/tokens";

const listRepos = {
  name: "github_list_repos",
  description: "List repos",
  integration: "github",
  inputSchema: z.object({ perPage: z.number().default(10) }),
  handler: vi.fn(),
};

const githubInteg = {
  name: "github",
  version: "1.0.0",
  displayName: "GitHub",
  auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
};

const jiraTool = {
  name: "jira_search_issues",
  description: "Search issues",
  integration: "atlassian-jira",
  inputSchema: z.object({}),
  handler: vi.fn(),
};

const AUTH = { "x-workbench-api-key": "valid-api-key" };

function stubRegistry() {
  vi.spyOn(registry, "getIntegration").mockImplementation((name: string) =>
    name === "github" ? (githubInteg as any) : undefined
  );
  vi.spyOn(registry, "listIntegrations").mockReturnValue([githubInteg as any]);
  vi.spyOn(registry, "listToolsByIntegration").mockImplementation((name: string) =>
    name === "github" ? ([listRepos] as any) : []
  );
  vi.spyOn(registry, "getTool").mockImplementation((name: string) => {
    if (name === "github_list_repos") return listRepos as any;
    if (name === "jira_search_issues") return jiraTool as any;
    return undefined;
  });
}

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  stubRegistry();
  vi.mocked(getToken).mockResolvedValue({ accessToken: "tok", scopes: "" } as any);
  listRepos.handler.mockResolvedValue({ repos: ["demo-repo"] });
  app = Fastify();
  await registerRestRoutes(app);
  await app.ready();
});

describe("POST /rest/:integration", () => {
  it("rejects an unauthenticated call with the /mcp challenge header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("oauth-protected-resource");
    expect(res.json().error).toBe("Unauthorized");
  });

  it("executes a tool named in the body and returns the raw result", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos", args: { perPage: 100 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      integration: "github",
      tool: "github_list_repos",
      result: { repos: ["demo-repo"] },
    });
    expect(listRepos.handler).toHaveBeenCalledWith(expect.anything(), { perPage: 100 });
  });

  it("accepts the flat body form — non-envelope keys become tool args", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos", perPage: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(listRepos.handler).toHaveBeenCalledWith(expect.anything(), { perPage: 50 });
  });

  it("accepts the bare tool name without the integration prefix", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "list_repos" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tool).toBe("github_list_repos");
  });

  it("applies plugin schema defaults, like /mcp does", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(200);
    expect(listRepos.handler).toHaveBeenCalledWith(expect.anything(), { perPage: 10 });
  });

  it("parses an empty JSON body to {} instead of FST_ERR_CTP_EMPTY_JSON_BODY", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: "",
    });
    // Empty body parses to {} — so the failure is the missing "tool", not a
    // content-type parser error.
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('"tool"');
  });

  it("400s a POST with no body — the tool name has to be in there", async () => {
    const res = await app.inject({ method: "POST", url: "/rest/github", headers: AUTH });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("JSON object");
  });

  it("415s a non-JSON content type instead of passing strings to the tool", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: { ...AUTH, "content-type": "application/x-www-form-urlencoded" },
      payload: "tool=github_list_repos",
    });
    expect(res.statusCode).toBe(415);
    expect(listRepos.handler).not.toHaveBeenCalled();
  });

  it("404s an unknown integration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/nope",
      headers: AUTH,
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Integration not found");
  });

  it("404s an unknown tool", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_nope" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Tool not found");
  });

  it("refuses a tool that belongs to another integration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "jira_search_issues" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("atlassian-jira");
    expect(jiraTool.handler).not.toHaveBeenCalled();
  });

  it("409s NOT_CONNECTED with the connect hint", async () => {
    vi.mocked(getToken).mockResolvedValue(null as any);
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("NOT_CONNECTED");
    expect(res.json().message).toContain("not connected");
  });

  it("400s arguments the plugin schema rejects", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos", args: { perPage: "many" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid arguments for github_list_repos");
  });

  it("502s a handler failure and keeps the upstream message", async () => {
    listRepos.handler.mockRejectedValue(new Error("github 503"));
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("github 503");
  });

  it("does not cap the result at the MCP 60,000-character limit", async () => {
    const big = "x".repeat(200_000);
    listRepos.handler.mockResolvedValue({ blob: big });
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: { tool: "github_list_repos" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.blob).toHaveLength(200_000);
    expect(res.body).not.toContain("result truncated");
  });

  it("runs a batch with index-aligned results and isolated failures", async () => {
    listRepos.handler.mockImplementation(async (_ctx: unknown, args: any) => ({ page: args.perPage }));
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: AUTH,
      payload: {
        executions: [
          { tool: "github_list_repos", args: { perPage: 1 } },
          { tool: "github_nope" },
          { tool: "list_repos", args: { perPage: 3 } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { results } = res.json();
    expect(results).toHaveLength(3);
    expect(results[0].result).toEqual({ page: 1 });
    expect(results[1].error).toContain("Tool not found");
    expect(results[2].result).toEqual({ page: 3 });
  });

  it("400s a body that is not an object", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rest/github",
      headers: { ...AUTH, "content-type": "application/json" },
      payload: JSON.stringify([1, 2]),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /rest discovery", () => {
  it("lists integrations with connection status", async () => {
    const res = await app.inject({ method: "GET", url: "/rest", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrations[0]).toMatchObject({
      name: "github",
      connected: true,
      toolCount: 1,
      url: "/rest/github",
    });
  });

  it("lists an integration's tools with portable JSON Schema", async () => {
    const res = await app.inject({ method: "GET", url: "/rest/github", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tools[0].name).toBe("github_list_repos");
    expect(body.tools[0].inputSchema.properties.perPage.type).toBe("number");
    expect(res.body).not.toContain("_def"); // no Zod internals leaked
  });

  it("404s an unknown integration", async () => {
    const res = await app.inject({ method: "GET", url: "/rest/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("requires auth", async () => {
    const res = await app.inject({ method: "GET", url: "/rest" });
    expect(res.statusCode).toBe(401);
  });
});
