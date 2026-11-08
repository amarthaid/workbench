import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));

import { config } from "../../src/config";
import { db } from "../../src/db";
import { installAuditContext } from "../../src/audit/context";
import { signSession } from "../../src/auth/session";
import { setApiKey } from "../../src/auth/users";
import { setUserDisabled } from "../../src/auth/user-status";
import { registerSpaceApiRoutes, containsVaultRef } from "../../src/spaces/api";
import { getSpace, setShares, updateSpaceMeta, upsertSpace, kvPut } from "../../src/spaces/store";
import { verifySig } from "../../src/spaces/sig";
import { _resetRateLimitForTest, _setNowForTest as setRateNow } from "../../src/spaces/rate-limit";
import { handlers, registerFixtures } from "./fixtures";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "./helpers";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
const TOOLS = ["acme_list_items", "acme_delete_item", "acme_unlabelled", "acme_fail", "acmeo_list_things"];
const prevAdmins = config.ADMIN_EMAILS;

function as(user: string) {
  return { authorization: `Bearer ${tokens[user]}` };
}

async function call(user: string, body: Record<string, unknown>, name = "s1") {
  return app.inject({ method: "POST", url: `/api/spaces/${name}/call`, headers: as(user), payload: body });
}

async function consent(user: string, name = "s1") {
  return app.inject({ method: "POST", url: `/api/spaces/${name}/consent`, headers: as(user) });
}

beforeAll(async () => {
  registerFixtures();
});

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-api-"));
  await resetSpacesDb();
  _resetRateLimitForTest();
  setRateNow(() => Date.now());
  config.ADMIN_EMAILS = ["admin@example.com"];
  for (const [id, email] of [
    ["u1", "dev@example.com"],
    ["u2", "qa@example.com"],
    ["u3", "ops@example.com"],
    ["admin", "admin@example.com"],
  ]) {
    await seedUser(id, email);
    tokens[id] = await signSession({ userId: id, email });
  }
  await upsertSpace({ name: "s1", ownerId: "u1", title: "Items", description: "d", tools: TOOLS, visibility: "users" });
  await setShares("s1", "u1", ["QA@example.com"]);
  writeSpaceFiles(tmp, "s1", { "index.html": "<p>s1</p>" });

  app = Fastify();
  installAuditContext(app);
  await registerSpaceApiRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  config.ADMIN_EMAILS = prevAdmins;
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("spaces API auth", () => {
  it("accepts only a portal session: API keys and junk bearers are 401", async () => {
    const { apiKey } = await setApiKey("u2");
    expect((await app.inject({ method: "GET", url: "/api/spaces" })).statusCode).toBe(401);
    const viaHeader = await app.inject({ method: "GET", url: "/api/spaces", headers: { "x-workbench-api-key": apiKey } });
    expect(viaHeader.statusCode).toBe(401);
    expect(viaHeader.json()).toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await app.inject({ method: "GET", url: "/api/spaces", headers: { authorization: `Bearer ${apiKey}` } })).statusCode).toBe(401);
    expect((await call("u2", { tool: "acme_list_items" }, "s1")).statusCode).not.toBe(401);
    // The API-key header is ignored, not preferred, when a session is present.
    const both = await app.inject({ method: "GET", url: "/api/spaces", headers: { ...as("u2"), "x-workbench-api-key": "wrong" } });
    expect(both.statusCode).toBe(200);
  });

  it("refuses a disabled user's session", async () => {
    await setUserDisabled("u2", true);
    expect((await app.inject({ method: "GET", url: "/api/spaces", headers: as("u2") })).statusCode).toBe(401);
  });
});

describe("GET /api/spaces", () => {
  it("lists what the viewer can open, newest first, live Spaces only", async () => {
    await upsertSpace({ name: "org1", ownerId: "u3", title: "Org", tools: [], visibility: "org" });
    writeSpaceFiles(tmp, "org1", { "index.html": "x" });
    await upsertSpace({ name: "priv", ownerId: "u3", title: "Private", tools: [], visibility: "private" });
    writeSpaceFiles(tmp, "priv", { "index.html": "x" });
    await upsertSpace({ name: "unuploaded", ownerId: "u2", title: "Draft", tools: [], visibility: "org" });
    await db.run("UPDATE spaces SET updated_at = ? WHERE name = ?", [1, "s1"]);
    await db.run("UPDATE spaces SET updated_at = ? WHERE name = ?", [3, "priv"]);
    await db.run("UPDATE spaces SET updated_at = ? WHERE name = ?", [2, "org1"]);

    const res = await app.inject({ method: "GET", url: "/api/spaces", headers: as("u2") });
    expect(res.statusCode).toBe(200);
    const spaces = res.json().spaces;
    expect(spaces.map((s: any) => s.name)).toEqual(["org1", "s1"]);
    expect(spaces[1]).toEqual({
      name: "s1",
      title: "Items",
      description: "d",
      ownerEmail: "dev@example.com",
      visibility: "users",
      updatedAt: 1,
      mine: false,
    });
    const own = (await app.inject({ method: "GET", url: "/api/spaces", headers: as("u3") })).json().spaces;
    expect(own.map((s: any) => [s.name, s.mine])).toEqual([
      ["priv", true],
      ["org1", true],
    ]);
  });
});

describe("GET /api/spaces/:name", () => {
  it("returns the spec shape with effects, connection state and a working appUrl", async () => {
    await db.run("UPDATE spaces SET tools = ? WHERE name = ?", [JSON.stringify([...TOOLS, "acme_ghost"].sort()), "s1"]);
    const res = await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: "s1",
      title: "Items",
      description: "d",
      ownerEmail: "dev@example.com",
      mine: false,
      visibility: "users",
      users: [],
      consented: false,
    });
    expect(typeof body.updatedAt).toBe("number");
    const byName = Object.fromEntries(body.tools.map((t: any) => [t.name, t]));
    expect(byName.acme_list_items).toEqual({
      name: "acme_list_items",
      integration: "acme",
      integrationName: "Acme CRM",
      effect: "read",
      connected: true,
      description: "List items",
    });
    expect(byName.acme_unlabelled.effect).toBe("destructive");
    expect(byName.acmeo_list_things).toMatchObject({ integration: "acme-oauth", connected: false });
    expect(byName.acme_ghost).toMatchObject({ missing: true, effect: "destructive" });

    const m = /^\/s\/s1\/app\/([^/]+)\/$/.exec(body.appUrl);
    expect(m).not.toBeNull();
    expect(verifySig("s1", m![1])).toBe("u2");
  });

  it("users go to the owner only", async () => {
    const owner = (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u1") })).json();
    expect(owner).toMatchObject({ mine: true, users: ["qa@example.com"] });
  });

  it("404s for a viewer without access, an admin, an unknown name and a Space with no upload", async () => {
    for (const user of ["u3", "admin"]) {
      const res = await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as(user) });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("NOT_FOUND");
    }
    expect((await app.inject({ method: "GET", url: "/api/spaces/nope", headers: as("u1") })).statusCode).toBe(404);
    await upsertSpace({ name: "draft", ownerId: "u1", title: "D", tools: [], visibility: "org" });
    expect((await app.inject({ method: "GET", url: "/api/spaces/draft", headers: as("u1") })).statusCode).toBe(404);
  });
});

describe("consent", () => {
  it("POST records it for the current hash, DELETE revokes", async () => {
    expect((await consent("u2")).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(true);
    const del = await app.inject({ method: "DELETE", url: "/api/spaces/s1/consent", headers: as("u2") });
    expect(del.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(false);
    expect((await consent("u3")).statusCode).toBe(404);
  });

  it("a change to the tool list invalidates it", async () => {
    await consent("u2");
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
    await updateSpaceMeta("s1", "u1", { tools: [...TOOLS, "acme_extra"] });
    const res = await call("u2", { tool: "acme_list_items" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(false);
  });
});

describe("POST /api/spaces/:name/call", () => {
  it("1. no access: 404 before anything else", async () => {
    const res = await call("u3", { tool: "nope", args: { x: "{{vault:k}}" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await call("admin", { tool: "acme_list_items" })).statusCode).toBe(404);
  });

  it("2. no consent: 403 CONSENT_REQUIRED, even for an undeclared tool", async () => {
    const res = await call("u2", { tool: "not_declared" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
  });

  it("3. undeclared: 403 TOOL_NOT_DECLARED, including real and internal tools", async () => {
    await consent("u2");
    for (const tool of ["deploy_jot", "acme_nonexistent", "jots"]) {
      const res = await call("u2", { tool });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "TOOL_NOT_DECLARED", tool });
    }
    expect((await call("u2", {})).json().code).toBe("TOOL_NOT_DECLARED");
    // A hint naming another integration does not resolve a declared name.
    expect((await call("u2", { tool: "acme_list_items", integration: "acme-oauth" })).json().code).toBe("TOOL_NOT_DECLARED");
  });

  it("3. resolves the bare suffix, with or without the integration, inside the declared list", async () => {
    await consent("u2");
    const hinted = await call("u2", { integration: "acme", tool: "list_items", args: { q: "x" } });
    expect(hinted.statusCode).toBe(200);
    expect(hinted.json()).toEqual({ result: { items: ["a", "b"], echo: { q: "x" } } });
    expect((await call("u2", { tool: "list_items" })).statusCode).toBe(200);
    expect((await call("u2", { integration: "acme-oauth", tool: "list_things" })).statusCode).toBe(409);
  });

  it("4. declared but gone from the registry: 404 TOOL_UNAVAILABLE", async () => {
    await updateSpaceMeta("s1", "u1", { tools: [...TOOLS, "acme_ghost"] });
    await consent("u2");
    const res = await call("u2", { tool: "acme_ghost", args: { x: "{{vault:k}}" } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "TOOL_UNAVAILABLE", tool: "acme_ghost" });
  });

  it("5. destructive (and unlabelled) needs confirmed: 428, then success with confirmed", async () => {
    await consent("u2");
    const spy = vi.spyOn(handlers, "remove");
    for (const tool of ["acme_delete_item", "acme_unlabelled"]) {
      const res = await call("u2", { tool, args: { id: "1" } });
      expect(res.statusCode).toBe(428);
      expect(res.json()).toMatchObject({ code: "CONFIRMATION_REQUIRED", integration: "acme", tool });
      expect((await call("u2", { tool, args: { id: "1" }, confirmed: "true" })).statusCode).toBe(428);
    }
    expect(spy).not.toHaveBeenCalled();
    const ok = await call("u2", { tool: "acme_delete_item", args: { id: "1" }, confirmed: true });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ result: { removed: true } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("5 before 6: a destructive call with a vault ref is asked to confirm first", async () => {
    await consent("u2");
    expect((await call("u2", { tool: "acme_delete_item", args: { id: "{{vault:k}}" } })).statusCode).toBe(428);
  });

  it("6. refuses {{vault: anywhere in args, values or keys, and never runs the tool", async () => {
    await consent("u2");
    const spy = vi.spyOn(handlers, "list");
    for (const args of [
      { q: "{{vault:prod_token}}" },
      { nested: { deep: ["ok", "prefix {{vault:x}} suffix"] } },
      { "{{vault:key}}": "value" },
    ]) {
      const res = await call("u2", { tool: "acme_list_items", args });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "INVALID_ARGS", tool: "acme_list_items" });
    }
    expect((await call("u2", { tool: "acme_list_items", args: ["a"] })).statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect(containsVaultRef({ a: [{ b: "{{step:x}}" }] })).toBe(false);
  });

  it("7. rate limit: 60 per minute per viewer and Space, then 429 with retryAfterMs", async () => {
    let t = 1_000_000;
    setRateNow(() => t);
    await consent("u2");
    await consent("u1");
    for (let i = 0; i < 60; i++) expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
    const over = await call("u2", { tool: "acme_list_items" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 1000 });
    // Checks before the limiter still answer first.
    expect((await call("u2", { tool: "acme_list_items", args: { q: "{{vault:x}}" } })).statusCode).toBe(400);
    // Another viewer has their own bucket.
    expect((await call("u1", { tool: "acme_list_items" })).statusCode).toBe(200);
    t += 1000;
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
  });

  it("8. outcome mapping: NOT_CONNECTED 409, bad args 400, upstream 502", async () => {
    await consent("u2");
    const nc = await call("u2", { tool: "acmeo_list_things" });
    expect(nc.statusCode).toBe(409);
    expect(nc.json()).toMatchObject({ code: "NOT_CONNECTED", integration: "acme-oauth", tool: "acmeo_list_things" });
    expect(typeof nc.json().message).toBe("string");

    const bad = await call("u2", { tool: "acme_delete_item", args: { id: 5 }, confirmed: true });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "INVALID_ARGS", integration: "acme", tool: "acme_delete_item" });

    const up = await call("u2", { tool: "acme_fail" });
    expect(up.statusCode).toBe(502);
    expect(up.json()).toMatchObject({ code: "UPSTREAM_ERROR", integration: "acme", tool: "acme_fail" });
    expect(typeof up.json().message).toBe("string");
  });

  it("audits the call as the viewer, with client_name space:<name> and auth_method session", async () => {
    await consent("u2");
    await db.exec("DELETE FROM audit_log");
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
    const rows = await db.all<{ user_id: string; tool: string; client_name: string; auth_method: string }>(
      "SELECT user_id, tool, client_name, auth_method FROM audit_log WHERE tool = ?",
      ["acme_list_items"]
    );
    expect(rows).toEqual([{ user_id: "u2", tool: "acme_list_items", client_name: "space:s1", auth_method: "session" }]);
  });
});

describe("KV", () => {
  const kv = (user: string, method: "GET" | "PUT" | "DELETE", key?: string, payload?: unknown) =>
    app.inject({
      method,
      url: key === undefined ? "/api/spaces/s1/kv" : `/api/spaces/s1/kv/${encodeURIComponent(key)}`,
      headers: as(user),
      ...(payload !== undefined ? { payload: payload as any } : {}),
    });

  it("requires access and consent", async () => {
    expect((await kv("u3", "GET")).statusCode).toBe(404);
    const res = await kv("u2", "GET");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("CONSENT_REQUIRED");
    expect((await kv("u2", "PUT", "k", { value: 1 })).statusCode).toBe(403);
  });

  it("round-trips any JSON per viewer", async () => {
    await consent("u2");
    await consent("u1");
    expect((await kv("u2", "PUT", "prefs", { value: { theme: "dark", n: [1, 2] } })).json()).toEqual({ ok: true });
    expect((await kv("u2", "PUT", "flag", { value: false })).statusCode).toBe(200);
    expect((await kv("u2", "GET", "prefs")).json()).toEqual({ value: { theme: "dark", n: [1, 2] } });
    expect((await kv("u2", "GET", "flag")).json()).toEqual({ value: false });
    expect((await kv("u2", "GET")).json()).toEqual({ keys: ["flag", "prefs"] });
    expect((await kv("u1", "GET")).json()).toEqual({ keys: [] });
    const missing = await kv("u1", "GET", "prefs");
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("KEY_NOT_FOUND");
    // A Space the viewer cannot open is the Space-level NOT_FOUND.
    expect((await kv("u3", "GET", "prefs")).json().code).toBe("NOT_FOUND");
    expect((await kv("u2", "DELETE", "prefs")).json()).toEqual({ ok: true });
    expect((await kv("u2", "GET")).json()).toEqual({ keys: ["flag"] });
  });

  it("shares the /call rate limit bucket", async () => {
    let t = 5_000_000;
    setRateNow(() => t);
    await consent("u2");
    for (let i = 0; i < 30; i++) expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
    for (let i = 0; i < 30; i++) expect((await kv("u2", "GET", "k")).statusCode).toBe(404);
    const over = await kv("u2", "PUT", "k", { value: 1 });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 1000 });
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(429);
    t += 1000;
    expect((await kv("u2", "GET")).statusCode).toBe(200);
  });

  it("enforces the limits: 413 TOO_LARGE, 400 for a bad key or missing value", async () => {
    await consent("u2");
    const big = await kv("u2", "PUT", "big", { value: "x".repeat(64 * 1024) });
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe("TOO_LARGE");
    for (const k of ["a", "b", "c", "d"]) await kvPut("s1", "u2", k, JSON.stringify("y".repeat(60 * 1024)));
    const total = await kv("u2", "PUT", "e", { value: "y".repeat(60 * 1024) });
    expect(total.statusCode).toBe(413);
    expect((await kv("u2", "PUT", "k".repeat(129), { value: 1 })).statusCode).toBe(400);
    // 128 characters is past find-my-way's 100-character param cap, and fine.
    await kv("u2", "DELETE", "a");
    expect((await kv("u2", "PUT", "k".repeat(128), { value: 1 })).statusCode).toBe(200);
    expect((await kv("u2", "PUT", "a/b c", { value: 2 })).statusCode).toBe(200);
    expect((await kv("u2", "GET", "a/b c")).json()).toEqual({ value: 2 });
    expect((await kv("u2", "PUT", "k", { nope: 1 })).statusCode).toBe(400);
  });
});

describe("cascade through the API", () => {
  it("a deleted Space 404s everywhere", async () => {
    await consent("u2");
    const { deleteSpace } = await import("../../src/spaces/store");
    await deleteSpace("s1");
    expect(await getSpace("s1")).toBeNull();
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).statusCode).toBe(404);
  });
});
