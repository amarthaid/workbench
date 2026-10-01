import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    ADMIN_EMAILS: ["admin@example.com"],
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    // The JWT claim says admin, but the DB (below) disagrees: DB must win.
    if (token === "claim-jwt") return { userId: "user-claim", email: "admin@example.com" };
    if (token === "ghost-jwt") return { userId: "user-ghost", email: "admin@example.com" };
    if (token === "noemail-jwt") return { userId: "user-noemail", email: "admin@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", () => ({
  // An admin's MCP key resolves to a real admin user: it still must not pass.
  verifyApiKey: vi.fn(async (key: string) => (key === "admin-key" ? "user-admin" : null)),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "Admin@Example.com " };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    if (id === "user-claim") return { id, email: "other@example.com" };
    if (id === "user-noemail") return { id, email: null };
    return null; // user-ghost: row is gone
  }),
}));

import { adminScope } from "../src/api/admin-scope";
import { config } from "../src/config";

async function buildApp() {
  const app = Fastify();
  await adminScope(app, (scope) => {
    scope.get("/probe", async () => ({ ok: true }));
  });
  return app;
}

const ping = (headers: Record<string, string> = {}) => ({
  method: "GET" as const,
  url: "/api/admin/probe",
  headers,
});

beforeEach(() => {
  vi.clearAllMocks();
  config.ADMIN_EMAILS = ["admin@example.com"];
});

describe("/api/admin gate", () => {
  it("401 with no credentials", async () => {
    const res = await (await buildApp()).inject(ping());
    expect(res.statusCode).toBe(401);
  });

  it("401 for an invalid session token", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer nope" }));
    expect(res.statusCode).toBe(401);
  });

  it("401 for an admin's API key: the key path never satisfies the gate", async () => {
    const res = await (await buildApp()).inject(ping({ "x-workbench-api-key": "admin-key" }));
    expect(res.statusCode).toBe(401);
  });

  it("403 for a signed-in user who is not an admin", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer dev-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("200 for an admin session, matching despite case and whitespace in the DB email", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer admin-jwt" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("403 when the JWT claim is an admin email but the DB email is not", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer claim-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("401 when the session's user row no longer exists", async () => {
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer ghost-jwt" }));
    expect(res.statusCode).toBe(401);
  });

  it("403 for a user with no email, even if the allowlist has an empty entry", async () => {
    config.ADMIN_EMAILS = ["", "admin@example.com"];
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer noemail-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("403 for everyone when the allowlist is empty", async () => {
    config.ADMIN_EMAILS = [];
    const res = await (await buildApp()).inject(ping({ authorization: "Bearer admin-jwt" }));
    expect(res.statusCode).toBe(403);
  });

  it("a rejected request still reaches root onRequest hooks registered after the scope", async () => {
    // index.ts registers the metrics onRequest hook after the admin scope. A gate
    // that replies from onRequest runs first and short-circuits it, so failed
    // admin auth would vanish from the HTTP metrics.
    const app = Fastify();
    await adminScope(app, (scope) => {
      scope.get("/probe", async () => ({ ok: true }));
    });
    let rootHookRan = false;
    app.addHook("onRequest", async () => {
      rootHookRan = true;
    });
    const res = await app.inject(ping());
    expect(res.statusCode).toBe(401);
    expect(rootHookRan).toBe(true);
  });

  it("gates a route added later in the same scope without it opting in", async () => {
    // Routes registered by later sub-projects live in this scope. Simulate one
    // on a fresh app (the same prefix cannot be registered twice on one app).
    const app = Fastify();
    await adminScope(app, async (scope) => {
      scope.get("/later", async () => ({ secret: true }));
    });
    const anon = await app.inject({ method: "GET", url: "/api/admin/later" });
    expect(anon.statusCode).toBe(401);
    const dev = await app.inject({
      method: "GET",
      url: "/api/admin/later",
      headers: { authorization: "Bearer dev-jwt" },
    });
    expect(dev.statusCode).toBe(403);
  });
});
