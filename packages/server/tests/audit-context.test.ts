import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  currentAuditContext,
  installAuditContext,
  noteAuth,
  noteRequestAuth,
  runWithAuditContext,
} from "../src/audit/context";
import { clientIp, trustProxyOption, trustsPeer } from "../src/trust-proxy";
import { config, configSchema } from "../src/config";

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

describe("trustsPeer", () => {
  it.each([
    [undefined, "10.0.0.1", false],
    [true, "203.0.113.9", true],
    [1, "203.0.113.9", true],
    [0, "203.0.113.9", false],
    [["10.0.0.0/8"], "10.1.2.3", true],
    [["10.0.0.0/8"], "::ffff:10.1.2.3", true],
    [["10.0.0.0/8"], "11.0.0.1", false],
    [["173.245.48.0/20", "2400:cb00::/32"], "2400:cb00::1", true],
    [["192.168.1.5"], "192.168.1.5", true],
    [["loopback"], "127.0.0.1", true],
    [["uniquelocal"], "172.20.0.4", true],
    [["uniquelocal"], "8.8.8.8", false],
  ] as const)("TRUST_PROXY=%j, peer %s → %s", (t, addr, want) => {
    expect(trustsPeer(t as never, addr)).toBe(want);
  });
});

describe("CLIENT_IP_HEADER (e.g. cf-connecting-ip)", () => {
  const req = (peer: string, headers: Record<string, string> = {}, ip = peer) => ({
    ip,
    headers,
    socket: { remoteAddress: peer },
  });
  const cf = { trust: ["173.245.48.0/20"], header: "cf-connecting-ip" };

  it("from a trusted peer, the header is the client address", () => {
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "203.0.113.9" }), cf)).toBe("203.0.113.9");
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "2001:db8::7" }), cf)).toBe("2001:db8::7");
  });

  it("from an untrusted peer the header is ignored (no spoofing by sending it yourself)", () => {
    expect(clientIp(req("198.51.100.66", { "cf-connecting-ip": "1.2.3.4" }), cf)).toBe("198.51.100.66");
  });

  it("without TRUST_PROXY the header is ignored", () => {
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "1.2.3.4" }), { trust: undefined, header: "cf-connecting-ip" })).toBe("173.245.48.10");
  });

  it("a missing or non-IP header falls back to request.ip", () => {
    expect(clientIp(req("173.245.48.10", {}, "10.9.9.9"), cf)).toBe("10.9.9.9");
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "1.2.3.4, 5.6.7.8" }), cf)).toBe("173.245.48.10");
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "<script>" }), cf)).toBe("173.245.48.10");
  });

  it("no header configured: request.ip (X-Forwarded-For per TRUST_PROXY)", () => {
    expect(clientIp(req("173.245.48.10", { "cf-connecting-ip": "1.2.3.4" }, "10.9.9.9"), { trust: ["173.245.48.0/20"] })).toBe("10.9.9.9");
  });

  it("end to end through Fastify: the audit context records the header's address", async () => {
    // The static import: an earlier block resets modules, and a dynamic import
    // here would mutate a different config instance than clientIp reads.
    const saved = { t: config.TRUST_PROXY, h: config.CLIENT_IP_HEADER };
    config.TRUST_PROXY = ["127.0.0.1"];
    config.CLIENT_IP_HEADER = "cf-connecting-ip";
    try {
      const app = appWith(trustProxyOption(config.TRUST_PROXY));
      app.get("/ip", async () => currentAuditContext());
      const res = await app.inject({
        method: "GET",
        url: "/ip",
        headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" },
      });
      expect(JSON.parse(res.body).source_ip).toBe("203.0.113.9");
    } finally {
      config.TRUST_PROXY = saved.t;
      config.CLIENT_IP_HEADER = saved.h;
    }
  });

  it("config: normalises the name and rejects junk", () => {
    expect(configSchema.parse({ CLIENT_IP_HEADER: " CF-Connecting-IP " }).CLIENT_IP_HEADER).toBe("cf-connecting-ip");
    expect(configSchema.safeParse({ CLIENT_IP_HEADER: "bad header!" }).success).toBe(false);
  });
});
