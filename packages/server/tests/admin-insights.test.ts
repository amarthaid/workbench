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

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdminRoutes } from "../src/api/admin-routes";
import { getFilesStats } from "../src/admin/files";
import { OTL_SENTINEL } from "../src/vault/otl";
import { config } from "../src/config";
import { db } from "../src/db";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

async function get(url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method: "GET", url, headers });
}

async function seedUser(id: string, email: string, disabledAt: number | null = null) {
  await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", [id, email, disabledAt]);
}

async function seedEvent(userId: string, o: { tool?: string; success?: boolean; at?: number; ms?: number } = {}) {
  await db.run(
    `INSERT INTO audit_log (user_id, integration, tool, action, success, error, duration_ms, created_at)
     VALUES (?, 'acme', ?, 'EXECUTE', ?, NULL, ?, ?)`,
    [userId, o.tool ?? "acme_search", o.success ?? true, o.ms ?? 100, o.at ?? NOW]
  );
}

async function seedSecret(userId: string, name: string, o: { lastUsed?: number | null; created?: number } = {}) {
  await db.run(
    "INSERT INTO user_vaults (id, user_id, name, value_enc, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
    [`${userId}-${name}`, userId, name, Buffer.from("gsecret"), o.created ?? NOW, o.lastUsed ?? null]
  );
}

beforeEach(async () => {
  prof.dir = mkdtempSync(join(tmpdir(), "insights-profiles-"));
  for (const t of ["audit_log", "connections", "user_vaults", "pending_auth", "users"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  config.ADMIN_EMAILS = ["admin@example.com"];
  config.AUDIT_LOG_DEST = "sqlite";
});

describe.each(["/api/admin/overview/stats", "/api/admin/overview/top-tools", "/api/admin/vault", "/api/admin/files"])(
  "%s gate",
  (url) => {
    it("401 without a session", async () => {
      expect((await get(url, {})).statusCode).toBe(401);
    });
    it("403 for a signed-in non-admin", async () => {
      expect((await get(url, DEV)).statusCode).toBe(403);
    });
  }
);

describe("GET /api/admin/overview/stats", () => {
  it("counts calls and errors in the last 24h against the 24h before", async () => {
    await seedUser("u1", "a@example.com");
    await seedEvent("u1");
    await seedEvent("u1", { success: false });
    await seedEvent("u1", { at: NOW - DAY - 60 });
    await seedEvent("u1", { at: NOW - 3 * DAY });
    const body = JSON.parse((await get("/api/admin/overview/stats")).body);
    expect(body).toMatchObject({ stored: true, calls_24h: 2, errors_24h: 1, calls_prev_24h: 1 });
  });

  it("counts distinct active users over 7 days, and disabled users", async () => {
    await seedUser("u1", "a@example.com");
    await seedUser("u2", "b@example.com", NOW);
    await seedUser("u3", "c@example.com");
    await seedEvent("u1");
    await seedEvent("u1", { at: NOW - 2 * DAY });
    await seedEvent("u2", { at: NOW - 6 * DAY });
    await seedEvent("u3", { at: NOW - 8 * DAY });
    const body = JSON.parse((await get("/api/admin/overview/stats")).body);
    expect(body).toMatchObject({ active_users_7d: 2, total_users: 3, disabled_users: 1 });
  });

  it("counts connections that expired with no refresh token", async () => {
    await seedUser("u1", "a@example.com");
    await db.run(
      "INSERT INTO connections (user_id, integration, access_token, refresh_token, expires_at) VALUES (?, ?, ?, NULL, ?)",
      ["u1", "jira", Buffer.from("tok-abc"), NOW - 10]
    );
    expect(JSON.parse((await get("/api/admin/overview/stats")).body).needs_reconnect).toBe(1);
  });

  it("says usage is not stored rather than reporting zeros, when audit is not in the database", async () => {
    config.AUDIT_LOG_DEST = "stdout";
    await seedUser("u1", "a@example.com");
    const body = JSON.parse((await get("/api/admin/overview/stats")).body);
    expect(body).toMatchObject({ stored: false, total_users: 1 });
  });
});

describe("GET /api/admin/overview/top-tools", () => {
  it("ranks tools by calls over 7 days with error counts and average duration", async () => {
    await seedUser("u1", "a@example.com");
    await seedEvent("u1", { tool: "t_a", ms: 100 });
    await seedEvent("u1", { tool: "t_a", ms: 300, success: false });
    await seedEvent("u1", { tool: "t_b" });
    await seedEvent("u1", { tool: "t_old", at: NOW - 8 * DAY });
    const body = JSON.parse((await get("/api/admin/overview/top-tools")).body);
    expect(body.stored).toBe(true);
    expect(body.tools).toEqual([
      { integration: "acme", tool: "t_a", calls: 2, errors: 1, avg_ms: 200 },
      { integration: "acme", tool: "t_b", calls: 1, errors: 0, avg_ms: 100 },
    ]);
  });

  it("reports not stored for a non-sqlite audit destination", async () => {
    config.AUDIT_LOG_DEST = "kafka";
    expect(JSON.parse((await get("/api/admin/overview/top-tools")).body)).toEqual({ stored: false, tools: [] });
  });
});

describe("GET /api/admin/vault", () => {
  it("counts secrets, holders and stale secrets, and ranks holders", async () => {
    await seedUser("u1", "a@example.com");
    await seedUser("u2", "b@example.com");
    await seedSecret("u1", "fresh", { lastUsed: NOW - DAY });
    await seedSecret("u1", "old-used", { lastUsed: NOW - 100 * DAY, created: NOW - 200 * DAY });
    await seedSecret("u1", "never-used-old", { created: NOW - 100 * DAY });
    await seedSecret("u1", "never-used-new", { created: NOW - DAY });
    await seedSecret("u2", "other", { lastUsed: NOW });
    const body = JSON.parse((await get("/api/admin/vault")).body);
    expect(body).toMatchObject({ secrets: 5, users_with_secrets: 2, stale: 2, stale_days: 90 });
    expect(body.top_holders).toEqual([
      { email: "a@example.com", secrets: 4 },
      { email: "b@example.com", secrets: 1 },
    ]);
  });

  it("never returns a secret's name or value", async () => {
    await seedUser("u1", "a@example.com");
    await seedSecret("u1", "prod-db-password", { lastUsed: NOW });
    const res = await get("/api/admin/vault");
    expect(res.body).not.toContain("prod-db-password");
    expect(res.body).not.toContain("gsecret");
  });

  it("counts only unexpired one-time links", async () => {
    await seedUser("u1", "a@example.com");
    for (const [state, exp] of [["t1", NOW + 600], ["t2", NOW - 5]] as const) {
      await db.run(
        "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
        [state, "u1", OTL_SENTINEL, exp, "enc"]
      );
    }
    expect(JSON.parse((await get("/api/admin/vault")).body).pending_links).toBe(1);
  });
});

describe("getFilesStats", () => {
  function put(root: string, key: string, name: string, bytes: number, ageSeconds: number) {
    mkdirSync(join(root, key), { recursive: true });
    const p = join(root, key, name);
    writeFileSync(p, Buffer.alloc(bytes));
    const t = Date.now() / 1000 - ageSeconds;
    utimesSync(p, t, t);
  }
  const emails = new Map<string, string | null>([["k1", "a@example.com"], ["k2", "b@example.com"]]);

  it("totals files and bytes, ranks users and files by size, and reports the oldest age", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    put(root, "k1", "a.bin", 100, 60);
    put(root, "k1", "b.bin", 50, 7200);
    put(root, "k2", "c.bin", 400, 10);
    const out = await getFilesStats({ root, emailByKey: emails });
    expect(out).toMatchObject({ files: 3, bytes: 550, users: 2 });
    expect(out.oldest_age_seconds).toBeGreaterThanOrEqual(7200);
    expect(out.top_users).toEqual([
      { email: "b@example.com", files: 1, bytes: 400 },
      { email: "a@example.com", files: 2, bytes: 150 },
    ]);
    expect(out.largest.map((f) => f.bytes)).toEqual([400, 100, 50]);
  });

  it("returns an empty result when the workspace does not exist, and never exposes a file name", async () => {
    const empty = await getFilesStats({ root: join(tmpdir(), "no-such-workspace-dir"), emailByKey: emails });
    expect(empty).toEqual({ files: 0, bytes: 0, users: 0, oldest_age_seconds: null, top_users: [], largest: [] });
    const root = mkdtempSync(join(tmpdir(), "files-"));
    put(root, "k1", "secret-report.pdf", 10, 1);
    expect(JSON.stringify(await getFilesStats({ root, emailByKey: emails }))).not.toContain("secret-report");
  });

  it("labels a directory whose user is gone with a null email", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-"));
    put(root, "orphan", "x", 5, 1);
    expect((await getFilesStats({ root, emailByKey: emails })).top_users[0].email).toBeNull();
  });
});
