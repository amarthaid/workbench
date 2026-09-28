import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    SERVER_PUBLIC_URL: "https://wb.example.com",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ENCRYPTION_KEY: "0".repeat(64),
    PORT: "3000",
  },
}));

const safeFetch = vi.fn();
vi.mock("../src/custom-apps/ssrf", async (importActual) => ({
  ...(await importActual<typeof import("../src/custom-apps/ssrf")>()),
  safeFetch: (...args: unknown[]) => safeFetch(...args),
}));

import {
  VIA_HEADER,
  MAX_HOPS,
  instanceId,
  parseVia,
  loopReason,
  runWithVia,
  outboundVia,
  withVia,
  isOwnResource,
  mcpLoopRefusal,
} from "../src/custom-apps/loop-guard";
import { discoverMetadata } from "../src/custom-apps/oauth";

const OTHER = "0123456789abcdef";

describe("instance id", () => {
  it("is a stable 16-hex id that does not carry the secret", () => {
    expect(instanceId()).toMatch(/^[0-9a-f]{16}$/);
    expect(instanceId()).toBe(instanceId());
    expect(instanceId()).not.toContain("test-session-secret");
  });
});

describe("parseVia", () => {
  it("splits, trims and lowercases the chain, dropping junk", () => {
    expect(parseVia(` ${OTHER.toUpperCase()} , nope, ${instanceId()}`)).toEqual([OTHER, instanceId()]);
    expect(parseVia([OTHER, "x"])).toEqual([OTHER]);
    expect(parseVia(undefined)).toEqual([]);
  });
});

describe("loopReason", () => {
  it("refuses a chain that already passed through this instance", () => {
    expect(loopReason([instanceId()])).toBe("self");
    expect(loopReason([OTHER, instanceId()])).toBe("self");
  });
  it("refuses a chain at the hop cap", () => {
    expect(loopReason(Array(MAX_HOPS).fill(OTHER))).toBe("hops");
  });
  it("lets a fresh or short foreign chain through", () => {
    expect(loopReason([])).toBeNull();
    expect(loopReason([OTHER])).toBeNull();
  });
});

describe("outbound chain", () => {
  it("is just this instance outside a request", () => {
    expect(outboundVia()).toBe(instanceId());
  });

  it("extends the inbound chain, across awaits", async () => {
    await runWithVia([OTHER], async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(outboundVia()).toBe(`${OTHER},${instanceId()}`);
    });
  });

  it("stamps the header on each request made through withVia, keeping other headers", async () => {
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    const f = withVia(inner);
    await runWithVia([OTHER], () => f("https://mcp.example.com/mcp", { headers: { Authorization: "Bearer tok-abc" } }));
    const headers = inner.mock.calls[0][1].headers as Headers;
    expect(headers.get(VIA_HEADER)).toBe(`${OTHER},${instanceId()}`);
    expect(headers.get("authorization")).toBe("Bearer tok-abc");
  });
});

describe("isOwnResource", () => {
  it("matches this instance's /mcp, with or without a trailing slash", () => {
    expect(isOwnResource("https://wb.example.com/mcp")).toBe(true);
    expect(isOwnResource("https://wb.example.com/mcp/")).toBe(true);
  });
  it("does not match another server or path", () => {
    expect(isOwnResource("https://other.example.com/mcp")).toBe(false);
    expect(isOwnResource("https://wb.example.com/other/mcp")).toBe(false);
    expect(isOwnResource(undefined)).toBe(false);
    expect(isOwnResource("not a url")).toBe(false);
  });
});

describe("discoverMetadata", () => {
  // Braces matter: a function returned from beforeEach is run as teardown.
  beforeEach(() => {
    safeFetch.mockReset();
  });

  function json(body: unknown) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("refuses an app that is this workbench, even behind another hostname", async () => {
    // The typed URL is an alias; the metadata it serves names this instance.
    safeFetch.mockImplementation(async (url: string) => {
      if (url === "https://alias.example.com/mcp") return new Response("", { status: 401 });
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: "https://wb.example.com/mcp", authorization_servers: ["https://wb.example.com"] });
      }
      return json({ authorization_endpoint: "https://wb.example.com/authorize", token_endpoint: "https://wb.example.com/token" });
    });
    await expect(discoverMetadata("https://alias.example.com/mcp")).rejects.toThrow(/this workbench/);
  });

  it("accepts another workbench instance", async () => {
    safeFetch.mockImplementation(async (url: string) => {
      if (url === "https://other.example.com/mcp") return new Response("", { status: 401 });
      if (url.endsWith("/.well-known/oauth-protected-resource")) {
        return json({ resource: "https://other.example.com/mcp", authorization_servers: ["https://other.example.com"] });
      }
      return json({ authorization_endpoint: "https://other.example.com/authorize", token_endpoint: "https://other.example.com/token" });
    });
    await expect(discoverMetadata("https://other.example.com/mcp")).resolves.toMatchObject({
      resourceUrl: "https://other.example.com/mcp",
    });
  });
});

describe("/mcp loop refusal", () => {
  // A trimmed /mcp wired the way index.ts wires it.
  async function buildApp() {
    const app = Fastify({ logger: false });
    app.post("/mcp", async (request, reply) => {
      const refusal = mcpLoopRefusal(request.headers[VIA_HEADER], request.body);
      if (refusal) return reply.status(refusal.status).send(refusal.body);
      return runWithVia(parseVia(request.headers[VIA_HEADER]), async () => ({ jsonrpc: "2.0", id: 1, result: { via: outboundVia() } }));
    });
    await app.ready();
    return app;
  }

  const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "execute_tools" } };

  it("answers 508 with a JSON-RPC error when the chain names this instance", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { [VIA_HEADER]: `${OTHER},${instanceId()}` }, payload: call });
    expect(res.statusCode).toBe(508);
    expect(res.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000 } });
    expect(res.json().error.message).toMatch(/loop/i);
  });

  it("runs a request from another instance and extends its chain", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { [VIA_HEADER]: OTHER }, payload: call });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.via).toBe(`${OTHER},${instanceId()}`);
  });

  it("runs a request with no chain at all", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/mcp", payload: call });
    expect(res.statusCode).toBe(200);
  });
});
