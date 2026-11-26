import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

vi.mock("../src/auth/users", async (orig) => ({
  ...(await orig<typeof import("../src/auth/users")>()),
  // An admin's API key resolves to the admin user: the gate must still refuse it.
  verifyApiKey: vi.fn(async (key: string) => (key === "admin-key" ? "user-admin" : null)),
  getUserById: vi.fn(async (id: string) => {
    if (id === "user-admin") return { id, email: "admin@example.com" };
    if (id === "user-dev") return { id, email: "dev@example.com" };
    return null;
  }),
}));

import { registerAdminRoutes } from "../src/api/admin-routes";
import { db } from "../src/db";
import { can } from "../src/permissions/store";
import { toolsHash, updateSpaceMeta, upsertSpace } from "../src/spaces/store";
import { CAPABILITIES, type CapabilityDef } from "../src/permissions/capabilities";

const ADMIN = { authorization: "Bearer admin-jwt" };
const DEV = { authorization: "Bearer dev-jwt" };
const CAP = "spaces.delegate_access";
const BASE = "/api/admin/users/user-dev/permissions";

async function call(
  method: "GET" | "PUT" | "DELETE",
  url: string,
  headers: Record<string, string> = ADMIN,
  payload?: unknown
) {
  const app = Fastify();
  await registerAdminRoutes(app);
  return app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function auditRows() {
  return db.all<{ user_id: string; action: string; tool: string }>(
    "SELECT user_id, action, tool FROM audit_log ORDER BY id"
  );
}

beforeEach(async () => {
  for (const t of ["audit_log", "user_permissions", "users", "spaces"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  const now = Math.floor(Date.now() / 1000);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-admin", "admin@example.com", now]);
  await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-dev", "dev@example.com", now]);
});

const ROUTES = [
  ["GET", BASE],
  ["PUT", `${BASE}/${CAP}`],
  ["DELETE", `${BASE}/${CAP}`],
] as const;

describe.each(ROUTES)("%s %s gate", (method, url) => {
  it("403 for a signed-in non-admin, and nothing changes", async () => {
    const res = await call(method, url, DEV, method === "PUT" ? { effect: "allow" } : undefined);
    expect(res.statusCode).toBe(403);
    expect(await can("user-dev", CAP)).toBe(false);
    expect(await auditRows()).toEqual([]);
  });
  it("401 for an admin's API key: the gate is session-only", async () => {
    const payload = method === "PUT" ? { effect: "allow" } : undefined;
    expect((await call(method, url, { "x-workbench-api-key": "admin-key" }, payload)).statusCode).toBe(401);
    expect((await call(method, url, { authorization: "Bearer admin-key" }, payload)).statusCode).toBe(401);
    expect(await can("user-dev", CAP)).toBe(false);
  });
  it("404 user_not_found for an unknown user", async () => {
    const res = await call(
      method,
      url.replace("user-dev", "user-ghost"),
      ADMIN,
      method === "PUT" ? { effect: "allow" } : undefined
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "user_not_found" });
  });
});

describe("GET /api/admin/users/:id/permissions", () => {
  it("lists every capability at its default and no delegated spaces", async () => {
    const res = await call("GET", BASE);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.delegatedSpaces).toBe(0);
    expect(body.permissions).toEqual([
      {
        capability: CAP,
        label: "Delegate access in Spaces",
        description: "Lets this user share Spaces that run with their connected apps.",
        default: "deny",
        effect: "deny",
        source: "default",
        grantedBy: null,
        grantedByEmail: null,
        grantedAt: null,
      },
    ]);
  });
});

describe("delegatedSpaces", () => {
  it("counts only this user's Spaces in owner mode", async () => {
    const space = (name: string, ownerId: string) =>
      upsertSpace({ name, ownerId, title: "T", tools: ["acme_list"], visibility: "org" });
    await space("dev-on", "user-dev");
    await space("dev-on-2", "user-dev");
    await space("dev-off", "user-dev");
    await space("admin-on", "user-admin");
    for (const [name, owner] of [["dev-on", "user-dev"], ["dev-on-2", "user-dev"], ["admin-on", "user-admin"]]) {
      await updateSpaceMeta(name, owner, {
        accessMode: "owner",
        confirmDelegation: true,
        expectedToolsHash: toolsHash(["acme_list"]),
      });
    }
    // Suspended by a tool change: still delegated, so still counted.
    await updateSpaceMeta("dev-on-2", "user-dev", { tools: ["acme_other"] });
    expect(JSON.parse((await call("GET", BASE)).body).delegatedSpaces).toBe(2);
  });
});

describe("PUT /api/admin/users/:id/permissions/:capability", () => {
  it("grants, shows as a rule by the admin, and writes one audit row", async () => {
    const res = await call("PUT", `${BASE}/${CAP}`, ADMIN, { effect: "allow" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(await can("user-dev", CAP)).toBe(true);

    const view = JSON.parse((await call("GET", BASE)).body).permissions[0];
    expect(view).toMatchObject({ capability: CAP, effect: "allow", source: "rule", grantedBy: "user-admin", grantedByEmail: "admin@example.com" });
    expect(typeof view.grantedAt).toBe("number");

    expect(await auditRows()).toEqual([
      { user_id: "user-admin", action: "ADMIN_PERMISSION_SET", tool: `admin.permission.set → dev@example.com ${CAP}` },
    ]);
  });

  it("400 unknown_capability for an undeclared capability, with no row and no audit", async () => {
    const res = await call("PUT", `${BASE}/nope`, ADMIN, { effect: "allow" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_capability" });
    expect(await db.all("SELECT * FROM user_permissions")).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  // spaces.delegate_access defaults to deny, so "deny" would be a no-op rule.
  it.each([[{ effect: "deny" }], [{ effect: "ALLOW" }], [{}], [null]])("400 invalid_effect for body %j", async (payload) => {
    const res = await call("PUT", `${BASE}/${CAP}`, ADMIN, payload);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_effect" });
    expect(await can("user-dev", CAP)).toBe(false);
    expect(await auditRows()).toEqual([]);
  });
});

describe("PUT on a capability that defaults to allow", () => {
  const registry = CAPABILITIES as unknown as Record<string, CapabilityDef>;
  const KEY = "test.default_allow";
  beforeEach(() => {
    registry[KEY] = { default: "allow", label: "Test", description: "Test capability." };
  });
  afterEach(() => {
    delete registry[KEY];
  });

  it("accepts only deny, the opposite of the default", async () => {
    const refused = await call("PUT", `${BASE}/${KEY}`, ADMIN, { effect: "allow" });
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body)).toEqual({ error: "invalid_effect" });
    expect(await db.all("SELECT * FROM user_permissions")).toEqual([]);

    const res = await call("PUT", `${BASE}/${KEY}`, ADMIN, { effect: "deny" });
    expect(res.statusCode).toBe(200);
    const row = await db.get<{ effect: string }>(
      "SELECT effect FROM user_permissions WHERE user_id = ? AND capability = ?",
      ["user-dev", KEY]
    );
    expect(row?.effect).toBe("deny");
    expect((await auditRows()).map((r) => r.action)).toEqual(["ADMIN_PERMISSION_SET"]);
  });
});

describe.each(["__proto__", "constructor", "toString"])("capability %s from Object.prototype", (key) => {
  it.each([["PUT"], ["DELETE"]] as const)("%s is 400 unknown_capability, with no row and no audit", async (method) => {
    const res = await call(method, `${BASE}/${key}`, ADMIN, method === "PUT" ? { effect: "allow" } : undefined);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_capability" });
    expect(await db.all("SELECT * FROM user_permissions")).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });
});

describe("DELETE /api/admin/users/:id/permissions/:capability", () => {
  it("returns the capability to its default and writes one audit row", async () => {
    await call("PUT", `${BASE}/${CAP}`, ADMIN, { effect: "allow" });
    const res = await call("DELETE", `${BASE}/${CAP}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(await can("user-dev", CAP)).toBe(false);

    const view = JSON.parse((await call("GET", BASE)).body).permissions[0];
    expect(view).toMatchObject({ effect: "deny", source: "default", grantedBy: null, grantedAt: null });

    expect((await auditRows()).map((r) => [r.action, r.tool])).toEqual([
      ["ADMIN_PERMISSION_SET", `admin.permission.set → dev@example.com ${CAP}`],
      ["ADMIN_PERMISSION_CLEAR", `admin.permission.clear → dev@example.com ${CAP}`],
    ]);
  });

  it("200 with no audit row when there was no rule to remove", async () => {
    const res = await call("DELETE", `${BASE}/${CAP}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(await auditRows()).toEqual([]);
  });

  it("400 unknown_capability for an undeclared capability", async () => {
    const res = await call("DELETE", `${BASE}/nope`);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unknown_capability" });
    expect(await auditRows()).toEqual([]);
  });
});
