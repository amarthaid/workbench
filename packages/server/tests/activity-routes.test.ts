import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    GOOGLE_CLIENT_ID: "test-gid",
    GOOGLE_CLIENT_SECRET: "test-gsecret",
    PORTAL_URL: "http://localhost:5173",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
    PLUGINS_DIR: "./plugins",
    CONNECT_TTL_SECONDS: 600,
    AUDIT_LOG_DEST: "sqlite",
    AUDIT_LOG_KAFKA_TOPIC: "audit-log",
  },
}));

vi.mock("../src/auth/session", () => ({
  signSession: vi.fn(() => "signed-jwt-token"),
  verifySession: vi.fn((token: string) => {
    if (token === "valid-jwt") return { userId: "user-1", email: "dev@example.com" };
    if (token === "other-jwt") return { userId: "user-2", email: "other@example.com" };
    throw new Error("Invalid token");
  }),
}));

vi.mock("../src/auth/users", () => ({
  verifyApiKey: vi.fn(() => null),
  getUserById: vi.fn(() => ({ id: "user-1", email: "dev@example.com" })),
  setApiKey: vi.fn(),
  getApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  hasApiKey: vi.fn(() => false),
}));

import { registerApiRoutes } from "../src/api/routes";
import { stopReaper } from "../src/auth/connections";
import { config } from "../src/config";
import { db } from "../src/db";

const NOW = Math.floor(Date.now() / 1000);
const AUTH = { authorization: "Bearer valid-jwt" };

async function buildApp() {
  const app = Fastify();
  await registerApiRoutes(app);
  return app;
}

async function seed(o: {
  userId: string;
  integration?: string | null;
  tool?: string;
  success?: boolean;
  createdAt?: number;
}) {
  await db.run(
    `INSERT INTO audit_log (user_id, integration, tool, action, success, error, duration_ms, created_at)
     VALUES (?, ?, ?, 'EXECUTE', ?, NULL, 100, ?)`,
    [
      o.userId,
      o.integration === undefined ? "acme" : o.integration,
      o.tool ?? "acme_search",
      o.success ?? true,
      o.createdAt ?? NOW,
    ]
  );
}

beforeEach(async () => {
  await db.exec("DELETE FROM audit_log");
  config.AUDIT_LOG_DEST = "sqlite";
  vi.clearAllMocks();
});

afterAll(() => stopReaper());

describe("GET /api/activity", () => {
  it("401s without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/activity" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the caller's events, newest first", async () => {
    await seed({ userId: "user-1", tool: "older", createdAt: NOW - 60 });
    await seed({ userId: "user-1", tool: "newer", createdAt: NOW });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/activity", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.stored).toBe(true);
    expect(body.events.map((e: { tool: string }) => e.tool)).toEqual(["newer", "older"]);
  });

  it("never leaks another user's events", async () => {
    await seed({ userId: "user-2", tool: "not-yours" });
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/activity", headers: AUTH });
    expect(JSON.parse(res.body).events).toEqual([]);
  });

  it("filters by integration and by status", async () => {
    await seed({ userId: "user-1", integration: "acme", tool: "ok_tool", success: true });
    await seed({ userId: "user-1", integration: "demo-repo", tool: "bad_tool", success: false });
    const app = await buildApp();

    const byInteg = await app.inject({
      method: "GET",
      url: "/api/activity?integration=demo-repo",
      headers: AUTH,
    });
    expect(JSON.parse(byInteg.body).events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);

    const byStatus = await app.inject({ method: "GET", url: "/api/activity?status=error", headers: AUTH });
    expect(JSON.parse(byStatus.body).events.map((e: { tool: string }) => e.tool)).toEqual(["bad_tool"]);
  });

  it("returns a cursor only while more rows remain, and pages with it", async () => {
    await seed({ userId: "user-1", tool: "a", createdAt: NOW });
    await seed({ userId: "user-1", tool: "b", createdAt: NOW - 1 });
    await seed({ userId: "user-1", tool: "c", createdAt: NOW - 2 });
    const app = await buildApp();

    const first = await app.inject({ method: "GET", url: "/api/activity?limit=2", headers: AUTH });
    const page1 = JSON.parse(first.body);
    expect(page1.events).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const second = await app.inject({
      method: "GET",
      url: `/api/activity?limit=2&cursor=${encodeURIComponent(page1.next_cursor)}`,
      headers: AUTH,
    });
    const page2 = JSON.parse(second.body);
    expect(page2.events.map((e: { tool: string }) => e.tool)).toEqual(["c"]);
    expect(page2.next_cursor).toBeNull();
  });

  it("400s on a cursor it did not mint", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/activity?cursor=tampered", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it("clamps limit into 1..100", async () => {
    for (let i = 0; i < 101; i++) await seed({ userId: "user-1", tool: `t${i}` });
    const app = await buildApp();

    const zero = await app.inject({ method: "GET", url: "/api/activity?limit=0", headers: AUTH });
    expect(JSON.parse(zero.body).events).toHaveLength(1);

    const huge = await app.inject({ method: "GET", url: "/api/activity?limit=9999", headers: AUTH });
    expect(JSON.parse(huge.body).events).toHaveLength(100);
  });

  it("falls back to the default of 50 on a non-numeric limit", async () => {
    for (let i = 0; i < 60; i++) await seed({ userId: "user-1", tool: `t${i}` });
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/activity?limit=notanumber", headers: AUTH });
    expect(JSON.parse(res.body).events).toHaveLength(50);
  });

  it("reports stored:false when audit events go somewhere other than the database", async () => {
    await seed({ userId: "user-1" });
    config.AUDIT_LOG_DEST = "stdout";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/activity", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ stored: false, events: [], next_cursor: null });
  });
});

describe("GET /api/stats", () => {
  it("401s without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("summarizes the caller's window", async () => {
    await seed({ userId: "user-1", integration: "acme", success: true });
    await seed({ userId: "user-1", integration: "acme", success: true });
    await seed({ userId: "user-1", integration: "demo-repo", success: false });
    await seed({ userId: "user-2", integration: "acme", success: true });
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/api/stats", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      stored: true,
      window_days: 30,
      tool_calls: 3,
      success_rate: 0.667,
      most_used_integration: "acme",
    });
  });

  it("returns a null rate when nothing happened in the window", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/stats", headers: AUTH });
    expect(JSON.parse(res.body)).toMatchObject({ tool_calls: 0, success_rate: null, most_used_integration: null });
  });

  it("reports stored:false when audit events go somewhere other than the database", async () => {
    config.AUDIT_LOG_DEST = "kafka";
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/stats", headers: AUTH });
    expect(JSON.parse(res.body)).toEqual({
      stored: false,
      window_days: 30,
      tool_calls: 0,
      success_rate: null,
      most_used_integration: null,
    });
  });
});
