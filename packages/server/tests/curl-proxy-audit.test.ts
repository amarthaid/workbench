import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const http = vi.hoisted(() => vi.fn());
vi.mock("../src/auth/curl-session", () => ({
  verifyCurlToken: vi.fn(async (t: string) => {
    if (t !== "curl-jwt") throw new Error("bad");
    return { userId: "user-1", integrations: ["acme"] };
  }),
}));
vi.mock("../src/plugins/context", () => ({
  createContext: vi.fn(async () => ({ http, getConfig: () => ({}) })),
}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: vi.fn(async () => {}) } }));

import { registerCurlProxy } from "../src/api/curl-proxy";
import { registry } from "../src/plugins/registry";
import { auditLogger } from "../src/audit/logger";

async function call(method: "GET" | "POST", url: string, token = "curl-jwt") {
  const app = Fastify();
  await registerCurlProxy(app);
  return app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: method === "POST" ? "{}" : undefined });
}

beforeEach(() => {
  vi.mocked(auditLogger.log).mockClear();
  http.mockReset();
  vi.spyOn(registry, "getIntegration").mockImplementation(
    (n: string) => (n === "acme" ? ({ name: "acme", proxy: { baseUrl: "https://api.example.com" } } as any) : undefined)
  );
});

describe("curl proxy audit", () => {
  it("writes one CURL_REQUEST row per call: method and path, no query string", async () => {
    http.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await call("GET", "/c/acme/repos/demo-repo/issues?q=secret-term&page=2");
    expect(res.statusCode).toBe(200);
    expect(auditLogger.log).toHaveBeenCalledTimes(1);
    const row = vi.mocked(auditLogger.log).mock.calls[0][0];
    expect(row).toMatchObject({
      user_id: "user-1",
      integration: "acme",
      action: "CURL_REQUEST",
      tool: "GET /repos/demo-repo/issues",
      success: true,
    });
    expect(JSON.stringify(row)).not.toContain("secret-term");
    expect(typeof row.duration_ms).toBe("number");
  });

  it("an upstream 4xx/5xx is recorded as a failure with its status", async () => {
    http.mockResolvedValue(new Response("nope", { status: 404 }));
    await call("POST", "/c/acme/things");
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "POST /things", success: false, error: "HTTP 404" })
    );
  });

  it("an upstream network error is recorded", async () => {
    http.mockRejectedValue(new Error("ECONNRESET"));
    const res = await call("GET", "/c/acme/x");
    expect(res.statusCode).toBe(502);
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining("ECONNRESET") })
    );
  });

  it("a request for an integration outside the session is recorded as refused", async () => {
    const res = await call("GET", "/c/other/x");
    expect(res.statusCode).toBe(403);
    expect(auditLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({ integration: "other", success: false, error: "integration not in this curl session" })
    );
    expect(http).not.toHaveBeenCalled();
  });

  it("an invalid token has no user to attribute, so nothing is written", async () => {
    expect((await call("GET", "/c/acme/x", "forged")).statusCode).toBe(401);
    expect(auditLogger.log).not.toHaveBeenCalled();
  });

  it("an audit failure does not fail the proxied call", async () => {
    vi.mocked(auditLogger.log).mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    http.mockResolvedValue(new Response("ok", { status: 200 }));
    expect((await call("GET", "/c/acme/x")).statusCode).toBe(200);
  });
});
