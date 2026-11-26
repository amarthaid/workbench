import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config", () => ({
  config: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000",
    NODE_ENV: "test",
    DATABASE_URL: process.env.DATABASE_URL,
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

async function get(url: string, headers: Record<string, string> = ADMIN) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method: "GET", url, headers });
}

async function seedSpace(name: string, title: string, ownerId = "user-dev") {
  await db.run(
    "INSERT INTO spaces (name, owner_id, title, description, tools, visibility, created_at, updated_at) VALUES (?, ?, ?, NULL, '[]', 'private', ?, ?)",
    [name, ownerId, title, NOW, NOW]
  );
}

beforeEach(async () => {
  for (const t of ["spaces", "users"]) await db.exec(`DELETE FROM ${t}`);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-admin", "admin@example.com", NOW]);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-dev", "dev@example.com", NOW]);
});

describe("GET /spaces (admin search)", () => {
  it("rejects a non-admin with 403", async () => {
    expect((await get("/api/admin/spaces?q=ab", DEV)).statusCode).toBe(403);
  });

  it("rejects missing, short and long q with 400", async () => {
    expect((await get("/api/admin/spaces")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces?q=a")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces?q=%20a%20")).statusCode).toBe(400);
    expect((await get(`/api/admin/spaces?q=${"a".repeat(65)}`)).statusCode).toBe(400);
    expect((await get(`/api/admin/spaces?q=${"a".repeat(64)}`)).statusCode).toBe(200);
  });

  it("caps limit at 20 and rejects a bad limit", async () => {
    for (let i = 0; i < 25; i++) await seedSpace(`team-${String(i).padStart(2, "0")}`, "T");
    const res = await get("/api/admin/spaces?q=team&limit=500");
    expect(res.json().spaces).toHaveLength(20);
    expect(res.json().has_more).toBe(true);
    expect((await get("/api/admin/spaces?q=team&limit=0")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces?q=team&limit=abc")).statusCode).toBe(400);
  });

  it("reports has_more false when everything fits", async () => {
    await seedSpace("alpha", "A");
    const res = await get("/api/admin/spaces?q=al&limit=5");
    expect(res.json().has_more).toBe(false);
  });

  it("sorts name-prefix hits before title hits, then by name", async () => {
    await seedSpace("aaa-report", "Quarterly sales");
    await seedSpace("sales-b", "Zeta");
    await seedSpace("sales-a", "Alpha");
    const res = await get("/api/admin/spaces?q=SALES");
    expect(res.json().spaces.map((s: { name: string }) => s.name)).toEqual(["sales-a", "sales-b", "aaa-report"]);
  });

  it("treats a hyphen or underscore in q as part of the prefix", async () => {
    await seedSpace("rel-desk", "One");
    await seedSpace("reldesk", "Two");
    await seedSpace("rel_tool", "Three");
    const names = async (q: string) => (await get("/api/admin/spaces?q=" + q)).json().spaces.map((s: { name: string }) => s.name);
    expect(await names("rel-")).toEqual(["rel-desk"]);
    expect(await names("rel_")).toEqual(["rel_tool"]);
  });

  it("matches % and _ literally", async () => {
    await seedSpace("plain-one", "100% done");
    await seedSpace("plain-two", "1000 done");
    await seedSpace("under-one", "a_b");
    await seedSpace("under-two", "axb");
    expect((await get("/api/admin/spaces?q=0%25")).json().spaces.map((s: { name: string }) => s.name)).toEqual(["plain-one"]);
    expect((await get("/api/admin/spaces?q=a_b")).json().spaces.map((s: { name: string }) => s.name)).toEqual(["under-one"]);
    expect((await get("/api/admin/spaces?q=%25%25")).json().spaces).toEqual([]);
  });

  it("returns only name, title and owner_email plus has_more", async () => {
    await seedSpace("alpha", "Alpha");
    const body = (await get("/api/admin/spaces?q=alp")).json();
    expect(Object.keys(body).sort()).toEqual(["has_more", "spaces"]);
    expect(body.spaces).toEqual([{ name: "alpha", title: "Alpha", owner_email: "dev@example.com" }]);
  });
});
