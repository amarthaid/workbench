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

import { registerCurlProxy, curlFailureReason } from "../src/api/curl-proxy";
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

  it("an upstream network error is recorded by its code, not its message", async () => {
    http.mockRejectedValue(
      Object.assign(new Error("fetch failed for https://api.example.com/x?q=secret-term"), { cause: { code: "ECONNRESET" } })
    );
    const res = await call("GET", "/c/acme/x");
    expect(res.statusCode).toBe(502);
    const row = vi.mocked(auditLogger.log).mock.calls[0][0];
    expect(row).toMatchObject({ success: false, error: "upstream request failed (ECONNRESET)" });
    expect(JSON.stringify(row)).not.toContain("secret-term");
  });

  it("a failed token refresh keeps the status and drops the response body", async () => {
    http.mockRejectedValue(new Error('Refresh failed 400: {"error":"invalid_grant","error_description":"secret-detail"}'));
    await call("GET", "/c/acme/x");
    const row = vi.mocked(auditLogger.log).mock.calls[0][0];
    expect(row.error).toBe("token refresh failed (HTTP 400)");
    expect(JSON.stringify(row)).not.toContain("secret-detail");
  });

  it("never records request or response bodies or headers", async () => {
    http.mockResolvedValue(new Response("response-body-secret", { status: 500, headers: { "x-upstream": "hdr-secret" } }));
    const app = Fastify();
    await registerCurlProxy(app);
    await app.inject({
      method: "POST",
      url: "/c/acme/things",
      headers: { authorization: "Bearer curl-jwt", "content-type": "application/json", "x-client": "req-hdr-secret" },
      payload: { password: "request-body-secret" },
    });
    const row = JSON.stringify(vi.mocked(auditLogger.log).mock.calls[0][0]);
    for (const leak of ["request-body-secret", "response-body-secret", "req-hdr-secret", "hdr-secret", "curl-jwt"]) {
      expect(row).not.toContain(leak);
    }
    expect(vi.mocked(auditLogger.log).mock.calls[0][0]).toMatchObject({ tool: "POST /things", error: "HTTP 500" });
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

describe("curlFailureReason", () => {
  it.each([
    [new Error("NOT_CONNECTED"), "not connected"],
    [new Error("Not connected"), "not connected"],
    [new Error("Token expired and no refresh_token stored"), "token expired"],
    [new Error("Cookie auth: URL host evil.example not in declared cookieDomains"), "target host not allowed"],
    [new Error("API-key auth: URL host evil.example not in declared allowedHosts"), "target host not allowed"],
    [new Error("something with a body: {...}"), "upstream request failed"],
    [Object.assign(new Error("x"), { cause: { code: "not a code; drop it" } }), "upstream request failed"],
    ["a string", "upstream request failed"],
  ])("%s → %s", (err, want) => {
    expect(curlFailureReason(err)).toBe(want);
  });
});
