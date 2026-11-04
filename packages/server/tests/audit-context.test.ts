import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  currentAuditContext,
  installAuditContext,
  noteAuth,
  noteRequestAuth,
  runWithAuditContext,
} from "../src/audit/context";
import { trustProxyOption } from "../src/trust-proxy";
import { configSchema } from "../src/config";

function appWith(opts: ReturnType<typeof trustProxyOption> = {}) {
  const app = Fastify({ ...opts });
  installAuditContext(app);
  return app;
}

describe("audit request context", () => {
  it("each handler sees its request's IP and user agent", async () => {
    const app = appWith();
    app.get("/x", async () => currentAuditContext());
    const res = await app.inject({ method: "GET", url: "/x", headers: { "user-agent": "claude-code/2.0" } });
    expect(JSON.parse(res.body)).toEqual({ source_ip: "127.0.0.1", user_agent: "claude-code/2.0" });
  });

  it("covers routes in plugins registered after it, and caps the user agent", async () => {
    const app = appWith();
    await app.register(
      async (scope) => {
        scope.get("/y", async () => currentAuditContext());
      },
      { prefix: "/p" }
    );
    const res = await app.inject({ method: "GET", url: "/p/y", headers: { "user-agent": "u".repeat(2000) } });
    expect(JSON.parse(res.body).user_agent).toHaveLength(512);
  });

  it("noteAuth inside the handler records the method and client", async () => {
    const app = appWith();
    app.get("/z", async () => {
      noteAuth("oauth", "client-abc");
      return currentAuditContext();
    });
    expect(JSON.parse((await app.inject({ method: "GET", url: "/z" })).body)).toMatchObject({
      auth_method: "oauth",
      client_id: "client-abc",
    });
  });

  it("auth decided in a preHandler hook reaches the handler", async () => {
    const app = appWith();
    app.addHook("preHandler", async (request) => noteRequestAuth(request, "session"));
    app.get("/h", async () => currentAuditContext());
    expect(JSON.parse((await app.inject({ method: "GET", url: "/h" })).body).auth_method).toBe("session");
  });

  it("concurrent requests keep their own context", async () => {
    const app = appWith();
    app.get("/c", async (req) => {
      await new Promise((r) => setTimeout(r, Number((req.query as { d: string }).d)));
      noteAuth((req.query as { m: "api_key" | "oauth" }).m);
      return currentAuditContext();
    });
    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/c?d=20&m=api_key", headers: { "user-agent": "A" } }),
      app.inject({ method: "GET", url: "/c?d=1&m=oauth", headers: { "user-agent": "B" } }),
    ]);
    expect(JSON.parse(a.body)).toMatchObject({ user_agent: "A", auth_method: "api_key" });
    expect(JSON.parse(b.body)).toMatchObject({ user_agent: "B", auth_method: "oauth" });
  });

  it("outside a request there is no context, and noteAuth is a no-op", () => {
    expect(currentAuditContext()).toBeUndefined();
    expect(() => noteAuth("api_key")).not.toThrow();
  });
});

describe("TRUST_PROXY", () => {
  const parse = (v?: string) => configSchema.parse({ TRUST_PROXY: v }).TRUST_PROXY;
  it("parses unset, true, a hop count and a CIDR list", () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse("false")).toBeUndefined();
    expect(parse("true")).toBe(true);
    expect(parse("2")).toBe(2);
    expect(parse("10.0.0.0/8, 192.168.1.5")).toEqual(["10.0.0.0/8", "192.168.1.5"]);
  });

  it("unset: X-Forwarded-For is ignored (a client cannot spoof its address)", async () => {
    const app = appWith(trustProxyOption(undefined));
    app.get("/ip", async () => currentAuditContext());
    const res = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(JSON.parse(res.body).source_ip).toBe("127.0.0.1");
  });

  it("a trusted proxy: the client address comes from X-Forwarded-For", async () => {
    const app = appWith(trustProxyOption(["127.0.0.1"]));
    app.get("/ip", async () => currentAuditContext());
    const res = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(JSON.parse(res.body).source_ip).toBe("203.0.113.9");
  });

  it("a hop count trusts that many hops", async () => {
    const app = appWith(trustProxyOption(1));
    app.get("/ip", async () => currentAuditContext());
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" },
    });
    expect(JSON.parse(res.body).source_ip).toBe("203.0.113.9");
  });
});

describe("resolveMcpUser notes the credential", () => {
  beforeEach(() => vi.resetModules());

  it.each([
    ["api_key", { "x-workbench-api-key": "wb-key" }, undefined],
    ["oauth", { authorization: "Bearer oauth-tok" }, "client-abc"],
    ["session", { authorization: "Bearer portal-jwt" }, undefined],
  ] as const)("%s", async (method, headers, clientId) => {
    vi.doMock("../src/auth/users", () => ({ verifyApiKey: async (k: string) => (k === "wb-key" ? "u1" : null) }));
    vi.doMock("../src/auth/oauth-server/tokens", () => ({
      verifyAccessToken: async (t: string) => {
        if (t === "oauth-tok") return { userId: "u1", scope: "mcp", clientId: "client-abc" };
        throw new Error("no");
      },
    }));
    vi.doMock("../src/auth/session", () => ({
      verifySession: async (t: string) => {
        if (t === "portal-jwt") return { userId: "u1" };
        throw new Error("no");
      },
    }));
    // After resetModules, take the context module from the same graph as resolve.ts.
    const { resolveMcpUser } = await import("../src/auth/oauth-server/resolve");
    const { runWithAuditContext: run } = await import("../src/audit/context");
    const ctx = {};
    const user = await run(ctx, () => resolveMcpUser(headers as Record<string, string>));
    expect(user).toBe("u1");
    expect(ctx).toEqual({ auth_method: method, client_id: clientId });
  });
});
