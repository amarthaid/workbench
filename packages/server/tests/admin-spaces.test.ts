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
  for (const t of ["space_user_state", "space_shares", "spaces", "users"]) await db.exec(`DELETE FROM ${t}`);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-admin", "admin@example.com", NOW]);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-dev", "dev@example.com", NOW]);
});

describe("GET /spaces/search (admin picker)", () => {
  it("rejects a non-admin with 403", async () => {
    expect((await get("/api/admin/spaces/search?q=ab", DEV)).statusCode).toBe(403);
  });

  it("rejects missing, short and long q with 400", async () => {
    expect((await get("/api/admin/spaces/search")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces/search?q=a")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces/search?q=%20a%20")).statusCode).toBe(400);
    expect((await get(`/api/admin/spaces/search?q=${"a".repeat(65)}`)).statusCode).toBe(400);
    expect((await get(`/api/admin/spaces/search?q=${"a".repeat(64)}`)).statusCode).toBe(200);
  });

  it("caps limit at 20 and rejects a bad limit", async () => {
    for (let i = 0; i < 25; i++) await seedSpace(`team-${String(i).padStart(2, "0")}`, "T");
    const res = await get("/api/admin/spaces/search?q=team&limit=500");
    expect(res.json().spaces).toHaveLength(20);
    expect(res.json().has_more).toBe(true);
    expect((await get("/api/admin/spaces/search?q=team&limit=0")).statusCode).toBe(400);
    expect((await get("/api/admin/spaces/search?q=team&limit=abc")).statusCode).toBe(400);
  });

  it("reports has_more false when everything fits", async () => {
    await seedSpace("alpha", "A");
    const res = await get("/api/admin/spaces/search?q=al&limit=5");
    expect(res.json().has_more).toBe(false);
  });

  it("sorts name-prefix hits before title hits, then by name", async () => {
    await seedSpace("aaa-report", "Quarterly sales");
    await seedSpace("sales-b", "Zeta");
    await seedSpace("sales-a", "Alpha");
    const res = await get("/api/admin/spaces/search?q=SALES");
    expect(res.json().spaces.map((s: { name: string }) => s.name)).toEqual(["sales-a", "sales-b", "aaa-report"]);
  });

  it("treats a hyphen or underscore in q as part of the prefix", async () => {
    await seedSpace("rel-desk", "One");
    await seedSpace("reldesk", "Two");
    await seedSpace("rel_tool", "Three");
    const names = async (q: string) => (await get("/api/admin/spaces/search?q=" + q)).json().spaces.map((s: { name: string }) => s.name);
    expect(await names("rel-")).toEqual(["rel-desk"]);
    expect(await names("rel_")).toEqual(["rel_tool"]);
  });

  it("matches % and _ literally", async () => {
    await seedSpace("plain-one", "100% done");
    await seedSpace("plain-two", "1000 done");
    await seedSpace("under-one", "a_b");
    await seedSpace("under-two", "axb");
    expect((await get("/api/admin/spaces/search?q=0%25")).json().spaces.map((s: { name: string }) => s.name)).toEqual(["plain-one"]);
    expect((await get("/api/admin/spaces/search?q=a_b")).json().spaces.map((s: { name: string }) => s.name)).toEqual(["under-one"]);
    expect((await get("/api/admin/spaces/search?q=%25%25")).json().spaces).toEqual([]);
  });

  it("returns only name, title and owner_email plus has_more", async () => {
    await seedSpace("alpha", "Alpha");
    const body = (await get("/api/admin/spaces/search?q=alp")).json();
    expect(Object.keys(body).sort()).toEqual(["has_more", "spaces"]);
    expect(body.spaces).toEqual([{ name: "alpha", title: "Alpha", owner_email: "dev@example.com" }]);
  });
});

describe("GET /api/admin/spaces (list)", () => {
  const LIST = "/api/admin/spaces";
  const DAY = 86_400_000;

  async function seed(
    name: string,
    o: { title?: string; updatedAt?: number; visibility?: string; owner?: string; description?: string | null } = {}
  ) {
    await db.run(
      "INSERT INTO spaces (name, owner_id, title, description, tools, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)",
      [name, o.owner ?? "user-dev", o.title ?? name, o.description ?? null, o.visibility ?? "org", 1, o.updatedAt ?? 1000]
    );
  }
  async function person(id: string) {
    await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", [id, `${id}@example.com`, NOW]);
  }
  const state = (space: string, user: string, opened: number | null, fav: number | null = null) =>
    db.run("INSERT INTO space_user_state (space_name, user_id, favorited_at, last_opened_at) VALUES (?, ?, ?, ?)", [space, user, fav, opened]);
  const names = (res: { json(): any }) => res.json().spaces.map((s: { name: string }) => s.name);

  it("is admin only: 401 without a session, 403 for a non-admin", async () => {
    expect((await get(LIST, {})).statusCode).toBe(401);
    expect((await get(LIST, DEV)).statusCode).toBe(403);
    expect((await get(LIST, { "x-workbench-api-key": "admin-key" })).statusCode).toBe(401);
  });

  it("lists newest updated first with name as the tiebreak", async () => {
    await seed("old", { updatedAt: 1 });
    await seed("new", { updatedAt: 3 });
    await seed("tie-b", { updatedAt: 2 });
    await seed("tie-a", { updatedAt: 2 });
    const res = await get(LIST);
    expect(res.statusCode).toBe(200);
    expect(names(res)).toEqual(["new", "tie-a", "tie-b", "old"]);
    expect(res.json().has_more).toBe(false);
    expect(res.json().next_cursor).toBeNull();
  });

  it("each item carries the card fields", async () => {
    await person("p1");
    await seed("alpha", { title: "Alpha", description: "About alpha", updatedAt: 5000 });
    await db.run("INSERT INTO space_shares (space_name, email) VALUES ('alpha', 'a@example.com')");
    await db.run("INSERT INTO space_shares (space_name, email) VALUES ('alpha', 'b@example.com')");
    await state("alpha", "p1", null, 10);
    const item = (await get(LIST)).json().spaces[0];
    expect(item).toEqual({
      name: "alpha",
      title: "Alpha",
      description: "About alpha",
      owner_email: "dev@example.com",
      visibility: "org",
      updated_at: 5000,
      share_count: 2,
      favorite_count: 1,
      openers_30d: 0,
      openers: [],
    });
  });

  it("pages by keyset across rows with equal updated_at, with no gaps or repeats", async () => {
    for (let i = 0; i < 7; i++) await seed(`s${i}`, { updatedAt: i < 4 ? 50 : 40 });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const res = await get(`${LIST}?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(res.statusCode).toBe(200);
      seen.push(...names(res));
      if (!res.json().has_more) {
        expect(res.json().next_cursor).toBeNull();
        break;
      }
      cursor = res.json().next_cursor;
      expect(typeof cursor).toBe("string");
    }
    expect(seen).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("the cursor is opaque base64 of [updatedAt, name]", async () => {
    for (let i = 0; i < 3; i++) await seed(`c${i}`, { updatedAt: 9 });
    const res = await get(`${LIST}?limit=1`);
    const decoded = JSON.parse(Buffer.from(res.json().next_cursor, "base64url").toString("utf8"));
    expect(decoded).toEqual([9, "c0"]);
  });

  it("rejects a malformed cursor and a bad limit", async () => {
    expect((await get(`${LIST}?cursor=not-a-cursor`)).statusCode).toBe(400);
    expect((await get(`${LIST}?cursor=${Buffer.from("[1]").toString("base64url")}`)).statusCode).toBe(400);
    expect((await get(`${LIST}?limit=0`)).statusCode).toBe(400);
    expect((await get(`${LIST}?limit=abc`)).statusCode).toBe(400);
  });

  it("limit defaults to 24 and is capped at 100", async () => {
    for (let i = 0; i < 105; i++) await seed(`n${String(i).padStart(3, "0")}`, { updatedAt: 1000 + i });
    const def = (await get(LIST)).json();
    expect(def.spaces).toHaveLength(24);
    expect(def.has_more).toBe(true);
    expect((await get(`${LIST}?limit=500`)).json().spaces).toHaveLength(100);
  });

  it("q filters by name prefix or title substring, literally", async () => {
    await seed("sales-a", { title: "Zeta" });
    await seed("zz", { title: "Quarterly sales" });
    await seed("x-sales", { title: "Other" });
    await seed("pct", { title: "100% done" });
    await seed("pct2", { title: "1000 done" });
    expect(names(await get(`${LIST}?q=SALES`)).sort()).toEqual(["sales-a", "zz"]);
    expect(names(await get(`${LIST}?q=0%25`))).toEqual(["pct"]);
  });

  it("openers cover only the visible page, the last 30 days, never the owner, and are skipped for private Spaces", async () => {
    for (const id of ["p1", "p2", "p3", "p4"]) await person(id);
    const now = Date.now();
    await seed("shown", { updatedAt: 20, visibility: "org" });
    await seed("hidden", { updatedAt: 10, visibility: "org" });
    await seed("priv", { updatedAt: 30, visibility: "private" });
    await state("shown", "user-dev", now - DAY); // owner
    await state("shown", "p1", now - 2 * DAY);
    await state("shown", "p2", now - 1 * DAY);
    await state("shown", "p3", now - 40 * DAY); // too old
    await state("hidden", "p1", now - DAY);
    await state("priv", "p1", now - DAY);
    const res = await get(`${LIST}?limit=2`);
    const by = Object.fromEntries(res.json().spaces.map((s: any) => [s.name, s]));
    expect(Object.keys(by)).toEqual(["priv", "shown"]);
    expect(by.shown.openers_30d).toBe(2);
    expect(by.shown.openers.map((o: any) => o.email)).toEqual(["p2@example.com", "p1@example.com"]);
    expect(by.shown.openers[0]).toEqual({ email: "p2@example.com", last_opened_at: now - DAY });
    expect(by.priv.openers_30d).toBe(0);
    expect(by.priv.openers).toEqual([]);
  });

  it("a Shared Space counts only people still on the list", async () => {
    for (const id of ["p1", "p2"]) await person(id);
    await seed("team", { visibility: "users" });
    await db.run("INSERT INTO space_shares (space_name, email) VALUES ('team', 'p1@example.com')");
    await state("team", "p1", Date.now());
    await state("team", "p2", Date.now()); // removed from the list since
    const item = (await get(LIST)).json().spaces[0];
    expect(item.openers.map((o: any) => o.email)).toEqual(["p1@example.com"]);
    expect(item.openers_30d).toBe(1);
  });

  it("makes a fixed number of queries however many Spaces are on the page", async () => {
    for (let i = 0; i < 12; i++) await seed(`q${i}`, { updatedAt: 100 + i });
    const spy = vi.spyOn(db, "all");
    await get(`${LIST}?limit=12`);
    const small = spy.mock.calls.length;
    spy.mockClear();
    for (let i = 12; i < 24; i++) await seed(`q${i}`, { updatedAt: 100 + i });
    await get(`${LIST}?limit=24`);
    expect(spy.mock.calls.length).toBe(small);
    spy.mockRestore();
  });
});
