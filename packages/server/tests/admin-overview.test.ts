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

vi.mock("../src/auth/users", () => ({
  verifyApiKey: vi.fn(async () => null),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

const prof = vi.hoisted(() => ({ dir: "" }));

vi.mock("../src/auth/profile-chromium", () => ({
  profilesBaseDir: () => prof.dir,
  profileDirName: (u: string) => u.replace(/[^a-zA-Z0-9_-]/g, "_"),
  activeProfiles: new Set<string>(),
}));

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminRoutes } from "../src/api/admin-routes";
import { config } from "../src/config";
import { db } from "../src/db";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };

async function get(url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method: "GET", url, headers });
}

async function seedUser(id: string, email: string | null) {
  await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, email]);
}

const NOW = Math.floor(Date.now() / 1000);

async function seedEvent(o: {
  userId: string;
  integration?: string;
  tool?: string;
  success?: boolean;
  createdAt?: number;
}) {
  await db.run(
    `INSERT INTO audit_log (user_id, integration, tool, action, success, error, duration_ms, created_at)
     VALUES (?, ?, ?, 'EXECUTE', ?, NULL, 100, ?)`,
    [o.userId, o.integration ?? "acme", o.tool ?? "acme_search", o.success ?? true, o.createdAt ?? NOW]
  );
}

async function seedConn(o: {
  userId: string;
  integration: string;
  expiresAt: number | null;
  refresh: boolean;
}) {
  await db.run(
    `INSERT INTO connections (user_id, integration, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [o.userId, o.integration, Buffer.from("tok-abc"), o.refresh ? Buffer.from("rtok-abc") : null, o.expiresAt]
  );
}

async function seedApp(o: { id: string; userId: string; name: string; url: string; createdAt: number }) {
  await db.run(
    `INSERT INTO custom_apps (id, user_id, name, base_url, metadata, client_id, client_secret_enc, created_at)
     VALUES (?, ?, ?, ?, '{}', 'cid-1', ?, ?)`,
    [o.id, o.userId, o.name, o.url, Buffer.from("gsecret-xyz"), o.createdAt]
  );
}

beforeEach(async () => {
  prof.dir = mkdtempSync(join(tmpdir(), "overview-profiles-"));
  for (const t of ["audit_log", "connections", "custom_apps", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  config.ADMIN_EMAILS = ["admin@example.com"];
  config.AUDIT_LOG_DEST = "sqlite";
  config.CLUSTER_ENABLED = false;
});

// Every overview endpoint is listed here so the gate is asserted for each.
const OVERVIEW_URLS = [
  "/api/admin/overview/instance",
  "/api/admin/overview/activity",
  "/api/admin/overview/connections",
  "/api/admin/overview/custom-apps",
  "/api/admin/overview/browser-profiles",
];

describe.each(OVERVIEW_URLS)("%s gate", (url) => {
  it("401 without a session", async () => {
    const res = await get(url, {});
    expect(res.statusCode).toBe(401);
  });

  it("403 for a signed-in non-admin", async () => {
    const res = await get(url, DEV);
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/admin/overview/instance", () => {
  it("reports version, backend, cluster flag, audit destination and counts", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    const res = await get("/api/admin/overview/instance");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      db_backend: "sqlite",
      cluster_enabled: false,
      audit_log_dest: "sqlite",
      audit_stored: true,
      user_count: 2,
      admin_count: 1,
    });
  });

  it("reports audit_stored false when events go elsewhere", async () => {
    config.AUDIT_LOG_DEST = "stdout";
    const body = JSON.parse((await get("/api/admin/overview/instance")).body);
    expect(body.audit_log_dest).toBe("stdout");
    expect(body.audit_stored).toBe(false);
  });

  it("reports the cluster flag", async () => {
    config.CLUSTER_ENABLED = true;
    const body = JSON.parse((await get("/api/admin/overview/instance")).body);
    expect(body.cluster_enabled).toBe(true);
  });

  it("counts admins but never reveals their emails", async () => {
    const res = await get("/api/admin/overview/instance");
    expect(JSON.parse(res.body).admin_count).toBe(1);
    expect(res.body).not.toContain("admin@example.com");
  });
});

describe("GET /api/admin/overview/activity", () => {
  it("returns every user's events, newest first, with the user's email", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-admin", tool: "older", createdAt: NOW - 10 });
    await seedEvent({ userId: "user-dev", tool: "newer", createdAt: NOW });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body.stored).toBe(true);
    expect(body.events.map((e: { tool: string }) => e.tool)).toEqual(["newer", "older"]);
    expect(body.events.map((e: { user_email: string }) => e.user_email)).toEqual([
      "dev@example.com",
      "admin@example.com",
    ]);
    expect(body.next_cursor).toBeNull();
  });

  it("gives a null email for an event whose user row is gone", async () => {
    await seedEvent({ userId: "user-ghost" });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].user_id).toBe("user-ghost");
    expect(body.events[0].user_email).toBeNull();
  });

  it("filters by user email, case-insensitively", async () => {
    await seedUser("user-admin", "admin@example.com");
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-admin", tool: "a" });
    await seedEvent({ userId: "user-dev", tool: "d" });
    const body = JSON.parse((await get("/api/admin/overview/activity?email=DEV@Example.com")).body);
    expect(body.events.map((e: { tool: string }) => e.tool)).toEqual(["d"]);
  });

  it("filters by integration and by status", async () => {
    await seedUser("user-dev", "dev@example.com");
    await seedEvent({ userId: "user-dev", integration: "acme", tool: "ok_tool", success: true });
    await seedEvent({ userId: "user-dev", integration: "demo-repo", tool: "bad_tool", success: false });
    const byInteg = JSON.parse((await get("/api/admin/overview/activity?integration=demo-repo")).body);
    expect(byInteg.events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);
    const byStatus = JSON.parse((await get("/api/admin/overview/activity?status=error")).body);
    expect(byStatus.events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);
  });

  it("says events are not stored when the audit destination is not sqlite", async () => {
    config.AUDIT_LOG_DEST = "stdout";
    await seedEvent({ userId: "user-dev" });
    const body = JSON.parse((await get("/api/admin/overview/activity")).body);
    expect(body).toEqual({ stored: false, events: [], next_cursor: null });
  });

  it("pages across rows sharing one second without skipping or repeating any", async () => {
    for (const tool of ["a", "b", "c"]) await seedEvent({ userId: "user-dev", tool, createdAt: NOW });
    const first = JSON.parse((await get("/api/admin/overview/activity?limit=2")).body);
    expect(first.events).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = JSON.parse(
      (await get(`/api/admin/overview/activity?limit=2&cursor=${first.next_cursor}`)).body
    );
    expect(second.events).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.events, ...second.events].map((e: { id: number }) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects a cursor it did not mint", async () => {
    const res = await get("/api/admin/overview/activity?cursor=not-a-cursor");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_cursor" });
  });

  it("clamps the page size to at least one row", async () => {
    await seedEvent({ userId: "user-dev", tool: "a", createdAt: NOW });
    await seedEvent({ userId: "user-dev", tool: "b", createdAt: NOW - 1 });
    const body = JSON.parse((await get("/api/admin/overview/activity?limit=0")).body);
    expect(body.events).toHaveLength(1);
  });

  it("treats an empty limit as the default page size, not as one row", async () => {
    await seedEvent({ userId: "user-dev", tool: "a", createdAt: NOW });
    await seedEvent({ userId: "user-dev", tool: "b", createdAt: NOW - 1 });
    const body = JSON.parse((await get("/api/admin/overview/activity?limit=")).body);
    expect(body.events).toHaveLength(2);
  });

  it("rejects an unknown status instead of silently returning everything", async () => {
    await seedEvent({ userId: "user-dev" });
    const res = await get("/api/admin/overview/activity?status=foo");
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_status" });
  });
});

describe("GET /api/admin/overview/connections", () => {
  it("counts connected users per integration and those needing a reconnect", async () => {
    await seedConn({ userId: "u1", integration: "jira", expiresAt: NOW + 3600, refresh: true });
    await seedConn({ userId: "u2", integration: "jira", expiresAt: NOW - 10, refresh: false }); // needs reconnect
    await seedConn({ userId: "u3", integration: "jira", expiresAt: NOW - 10, refresh: true }); // can refresh
    await seedConn({ userId: "u1", integration: "slack", expiresAt: null, refresh: false }); // cookie / api key
    await seedConn({ userId: "u1", integration: "custom:abc", expiresAt: NOW - 10, refresh: false }); // custom app
    const res = await get("/api/admin/overview/connections");
    expect(JSON.parse(res.body)).toEqual({
      integrations: [
        { integration: "jira", connected: 3, needs_reconnect: 1 },
        { integration: "slack", connected: 1, needs_reconnect: 0 },
      ],
    });
    expect(res.body).not.toContain("tok-abc");
  });

  it("returns an empty list when nothing is connected", async () => {
    expect(JSON.parse((await get("/api/admin/overview/connections")).body)).toEqual({ integrations: [] });
  });
});

describe("GET /api/admin/overview/custom-apps", () => {
  it("lists apps across users with the owner's email, newest first, and no secrets", async () => {
    await seedUser("user-dev", "dev@example.com");
    await seedApp({ id: "app-1", userId: "user-dev", name: "older", url: "https://mcp.example.com/a", createdAt: NOW - 100 });
    await seedApp({ id: "app-2", userId: "user-dev", name: "newer", url: "https://mcp.example.com/b", createdAt: NOW });
    const res = await get("/api/admin/overview/custom-apps");
    const body = JSON.parse(res.body);
    expect(body.total).toBe(2);
    expect(body.apps.map((a: { name: string }) => a.name)).toEqual(["newer", "older"]);
    expect(body.apps[0]).toEqual({
      id: "app-2",
      name: "newer",
      base_url: "https://mcp.example.com/b",
      owner_email: "dev@example.com",
      created_at: NOW,
    });
    expect(res.body).not.toContain("gsecret");
    expect(res.body).not.toContain("cid-1");
    expect(res.body).not.toContain("client_secret");
  });

  it("gives a null owner email when the owning user is gone", async () => {
    await seedApp({ id: "app-9", userId: "user-ghost", name: "orphan", url: "https://mcp.example.com/z", createdAt: NOW });
    const body = JSON.parse((await get("/api/admin/overview/custom-apps")).body);
    expect(body.apps[0].owner_email).toBeNull();
  });
});

describe("GET /api/admin/overview/browser-profiles", () => {
  it("lists profiles with the owner's email and size, without leaking the path", async () => {
    await seedUser("user-dev", "dev@example.com");
    mkdirSync(join(prof.dir, "user-dev", "Default"), { recursive: true });
    writeFileSync(join(prof.dir, "user-dev", "Default", "Cookies"), Buffer.alloc(10));
    const res = await get("/api/admin/overview/browser-profiles");
    const body = JSON.parse(res.body);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({
      name: "user-dev",
      email: "dev@example.com",
      bytes: 10,
      live: true,
    });
    expect(res.body).not.toContain(prof.dir);
  });

  it("lists profiles without a worker-scope caveat, in cluster mode too", async () => {
    // Cluster workers share one profiles volume, so the listing is complete.
    config.CLUSTER_ENABLED = true;
    const body = JSON.parse((await get("/api/admin/overview/browser-profiles")).body);
    expect(body).toEqual({ profiles: [] });
  });
});
