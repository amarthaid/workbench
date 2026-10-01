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

beforeEach(async () => {
  for (const t of ["audit_log", "connections", "custom_apps", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  config.ADMIN_EMAILS = ["admin@example.com"];
  config.AUDIT_LOG_DEST = "sqlite";
  config.CLUSTER_ENABLED = false;
});

// Every overview endpoint is listed here so the gate is asserted for each.
const OVERVIEW_URLS = ["/api/admin/overview/instance"];

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
