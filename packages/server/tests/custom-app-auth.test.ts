import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

const connects: Array<{ headers: Record<string, string>; kind: string }> = [];
const closes: string[] = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    closed = false;
    async connect(t: { headers: Record<string, string>; kind: string }) { connects.push({ headers: t.headers, kind: t.kind }); }
    async close() { closes.push("closed"); }
    async listTools() { return { tools: [{ name: "ping", inputSchema: {} }] }; }
    async callTool() { return { content: [{ type: "text", text: "ok" }] }; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPError: class extends Error { constructor(public code: number, m: string) { super(m); } },
  StreamableHTTPClientTransport: class {
    kind = "streamable";
    headers: Record<string, string>;
    constructor(_u: URL, o: { requestInit: { headers: Record<string, string> } }) { this.headers = o.requestInit.headers; }
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    kind = "sse";
    headers: Record<string, string>;
    constructor(_u: URL, o: { requestInit: { headers: Record<string, string> } }) { this.headers = o.requestInit.headers; }
  },
}));

import { discoverTools, evictSession } from "../src/custom-apps/client";
import { resolveAuthHeaders, upstreamAuthHint } from "../src/custom-apps/auth";
import type { CustomApp } from "../src/custom-apps/store";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = { id: "a1", userId: "u1", name: "k", baseUrl: "https://mcp.example.com/mcp", metadata: {}, createdAt: 0, updatedAt: 0 };

beforeEach(async () => {
  evictSession("u1", "https://mcp.example.com/mcp");
  await Promise.resolve(); // let the evicted client's async close() settle before counting
  connects.length = 0;
  closes.length = 0;
});

describe("resolveAuthHeaders", () => {
  it("returns the static headers for a headers app, with no OAuth lookup", async () => {
    const app: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: "tok-abc" }] };
    expect(await resolveAuthHeaders("u1", app)).toEqual({ "X-Api-Key": "tok-abc" });
  });

  it("an empty (corrupt) header set yields an error, not an unauthenticated call", async () => {
    const app: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [] };
    await expect(resolveAuthHeaders("u1", app)).rejects.toThrow(/headers/i);
  });
});

describe("client session cache keyed by header fingerprint", () => {
  const url = "https://mcp.example.com/mcp";

  it("sends the given headers and reuses the session for identical headers", async () => {
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    expect(connects).toHaveLength(1);
    expect(connects[0].headers).toEqual({ "X-Api-Key": "tok-abc" });
  });

  it("closes the old session and stops sending the old key when headers change", async () => {
    await discoverTools("u1", url, { "X-Api-Key": "tok-abc" });
    await discoverTools("u1", url, { "X-Api-Key": "tok-new" });
    expect(connects).toHaveLength(2);
    expect(closes).toHaveLength(1);
    expect(connects[1].headers).toEqual({ "X-Api-Key": "tok-new" });
  });
});

describe("upstreamAuthHint", () => {
  const headersApp: CustomApp = { ...base, metadata: { authType: "headers" }, headers: [{ name: "X-Api-Key", value: "tok-abc" }] };
  it("maps 401/403 on a headers app to a check-your-headers hint without any value", () => {
    const hint = upstreamAuthHint(headersApp, new StreamableHTTPError(401, "boom tok-abc"));
    expect(hint).toMatch(/check the app's headers/i);
    expect(hint).not.toContain("tok-abc");
  });
  it("returns null for other errors and for OAuth apps", () => {
    expect(upstreamAuthHint(headersApp, new Error("x"))).toBeNull();
    expect(upstreamAuthHint(base as CustomApp, new StreamableHTTPError(401, "x"))).toBeNull();
  });
});
