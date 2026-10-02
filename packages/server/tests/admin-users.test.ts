import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    ADMIN_EMAILS: ["admin@example.com"],
    AUDIT_LOG_DEST: "sqlite",
    CLUSTER_ENABLED: false,
  },
}));

vi.mock("../src/auth/session", () => ({
  verifySession: vi.fn((token: string) => {
    if (token === "admin-jwt") return { userId: "user-admin", email: "admin@example.com" };
    if (token === "dev-jwt") return { userId: "user-dev", email: "dev@example.com" };
    throw new Error("Invalid token");
  }),
}));

// Keep the real clearApiKey; stub only what the gate resolves identity with.
vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { db } from "../src/db";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };
const NOW = Math.floor(Date.now() / 1000);

async function call(method: "GET" | "POST", url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method, url, headers });
}

async function seedUser(o: {
  id: string;
  email: string | null;
  apiKeyHash?: string | null;
  createdAt?: number;
  disabledAt?: number | null;
}) {
  await db.run(
    "INSERT INTO users (id, email, api_key_hash, created_at, disabled_at) VALUES (?, ?, ?, ?, ?)",
    [o.id, o.email, o.apiKeyHash ?? null, o.createdAt ?? NOW, o.disabledAt ?? null]
  );
}

async function userRow(id: string) {
  return db.get<{ disabled_at: number | null; api_key_hash: string | null }>(
    "SELECT disabled_at, api_key_hash FROM users WHERE id = ?",
    [id]
  );
}

async function auditActions() {
  const rows = await db.all<{ user_id: string; action: string; tool: string }>(
    "SELECT user_id, action, tool FROM audit_log ORDER BY id"
  );
  return rows;
}

beforeEach(async () => {
  for (const t of ["audit_log", "connections", "custom_apps", "oauth_refresh_tokens", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  await seedUser({ id: "user-admin", email: "admin@example.com" });
});

const ACTIONS = [
  ["POST", "/api/admin/users/x/disable"],
  ["POST", "/api/admin/users/x/enable"],
  ["POST", "/api/admin/users/x/revoke-key"],
  ["GET", "/api/admin/users"],
] as const;

describe.each(ACTIONS)("%s %s gate", (method, url) => {
  it("401 without a session", async () => {
    expect((await call(method, url, {})).statusCode).toBe(401);
  });
  it("403 for a signed-in non-admin", async () => {
    expect((await call(method, url, DEV)).statusCode).toBe(403);
  });
});

describe("GET /api/admin/users", () => {
  it("lists users newest first with counts, last activity and disabled state, and no secrets", async () => {
    await seedUser({ id: "user-a", email: "a@example.com", apiKeyHash: "hash-secret-1", createdAt: NOW - 200 });
    await seedUser({ id: "user-b", email: "b@example.com", createdAt: NOW - 100, disabledAt: NOW - 50 });
    await db.run("INSERT INTO connections (user_id, integration, access_token) VALUES (?, ?, ?)", ["user-a", "jira", Buffer.from("tok-abc")]);
    await db.run("INSERT INTO connections (user_id, integration, access_token) VALUES (?, ?, ?)", ["user-a", "slack", Buffer.from("tok-abc")]);
    await db.run(
      "INSERT INTO custom_apps (id, user_id, name, base_url, metadata, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
      ["app-1", "user-a", "wiki", "https://mcp.example.com/w", NOW]
    );
    await db.run(
      "INSERT INTO audit_log (user_id, integration, tool, action, success, created_at) VALUES (?, ?, ?, 'EXECUTE', ?, ?)",
      ["user-a", "acme", "acme_search", true, NOW - 5]
    );

    const res = await call("GET", "/api/admin/users");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const byId = Object.fromEntries(body.users.map((u: { id: string }) => [u.id, u]));
    expect(body.users.map((u: { id: string }) => u.id)).toEqual(["user-admin", "user-b", "user-a"]);
    expect(body.total).toBe(3);
    expect(byId["user-a"]).toEqual({
      id: "user-a",
      email: "a@example.com",
      created_at: NOW - 200,
      disabled_at: null,
      has_api_key: true,
      connection_count: 2,
      custom_app_count: 1,
      last_activity: NOW - 5,
    });
    expect(byId["user-b"]).toMatchObject({ has_api_key: false, disabled_at: NOW - 50, last_activity: null });
    expect(res.body).not.toContain("hash-secret-1");
    expect(res.body).not.toContain("tok-abc");
  });
});

describe("POST /api/admin/users/:id/disable", () => {
  it("disables the user, deletes only that user's refresh tokens, and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com" });
    await seedUser({ id: "user-o", email: "o@example.com" });
    for (const [hash, uid] of [["h1", "user-t"], ["h2", "user-t"], ["h3", "user-o"]]) {
      await db.run(
        "INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
        [hash, "c1", uid, "mcp", NOW + 3600]
      );
    }
    const res = await call("POST", "/api/admin/users/user-t/disable");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect((await userRow("user-t"))?.disabled_at).not.toBeNull();
    expect((await userRow("user-o"))?.disabled_at).toBeNull();
    const left = await db.all<{ user_id: string }>("SELECT user_id FROM oauth_refresh_tokens");
    expect(left.map((r) => r.user_id)).toEqual(["user-o"]);
    const audit = await auditActions();
    expect(audit).toEqual([
      { user_id: "user-admin", action: "ADMIN_USER_DISABLE", tool: "admin.user.disable → t@example.com" },
    ]);
  });

  it("is idempotent: disabling again keeps the original time", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", disabledAt: 1234 });
    expect((await call("POST", "/api/admin/users/user-t/disable")).statusCode).toBe(200);
    expect(Number((await userRow("user-t"))?.disabled_at)).toBe(1234);
  });

  it("refuses to disable yourself and changes nothing", async () => {
    await db.run(
      "INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)",
      ["h1", "c1", "user-admin", "mcp", NOW + 3600]
    );
    const res = await call("POST", "/api/admin/users/user-admin/disable");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "cannot_disable_self" });
    expect((await userRow("user-admin"))?.disabled_at).toBeNull();
    expect(await db.all("SELECT 1 FROM oauth_refresh_tokens")).toHaveLength(1);
    expect(await auditActions()).toEqual([]);
  });

  it("refuses to disable another email on ADMIN_EMAILS, matching case-insensitively", async () => {
    await seedUser({ id: "user-other-admin", email: "Admin@Example.com" });
    const res = await call("POST", "/api/admin/users/user-other-admin/disable");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "cannot_disable_admin" });
    expect((await userRow("user-other-admin"))?.disabled_at).toBeNull();
    expect(await auditActions()).toEqual([]);
  });

  it("404 for an unknown user", async () => {
    const res = await call("POST", "/api/admin/users/nope/disable");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "user_not_found" });
  });
});

describe("POST /api/admin/users/:id/enable", () => {
  it("enables the user and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", disabledAt: NOW - 10 });
    const res = await call("POST", "/api/admin/users/user-t/enable");
    expect(res.statusCode).toBe(200);
    expect((await userRow("user-t"))?.disabled_at).toBeNull();
    expect(await auditActions()).toEqual([
      { user_id: "user-admin", action: "ADMIN_USER_ENABLE", tool: "admin.user.enable → t@example.com" },
    ]);
  });

  it("404 for an unknown user", async () => {
    expect((await call("POST", "/api/admin/users/nope/enable")).statusCode).toBe(404);
  });
});

describe("POST /api/admin/users/:id/revoke-key", () => {
  it("clears that user's API key only, and audits it", async () => {
    await seedUser({ id: "user-t", email: "t@example.com", apiKeyHash: "hash-1" });
    await seedUser({ id: "user-o", email: "o@example.com", apiKeyHash: "hash-2" });
    const res = await call("POST", "/api/admin/users/user-t/revoke-key");
    expect(res.statusCode).toBe(200);
    expect((await userRow("user-t"))?.api_key_hash).toBeNull();
    expect((await userRow("user-o"))?.api_key_hash).toBe("hash-2");
    expect(await auditActions()).toEqual([
      { user_id: "user-admin", action: "ADMIN_KEY_REVOKE", tool: "admin.user.revoke-key → t@example.com" },
    ]);
  });

  it("404 for an unknown user", async () => {
    expect((await call("POST", "/api/admin/users/nope/revoke-key")).statusCode).toBe(404);
  });
});
