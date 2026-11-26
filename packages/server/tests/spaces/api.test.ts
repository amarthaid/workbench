import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));
// Passes through; a test can make the write lose a race.
vi.mock("../../src/spaces/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/spaces/store")>();
  return { ...actual, updateSpaceMeta: vi.fn(actual.updateSpaceMeta) };
});

// The reconnect runner, observed without replacing ensureCookieSession or
// createContext. `reconnectSession` is wrapped where other modules import it
// (ctx.http); ensureCookieSession calls it inside its own module, where no
// wrapper reaches, so `mayOwnBrowser` (the first thing a run asks) is the
// probe for that path. Answering false keeps any run off a real browser.
const recon = vi.hoisted(() => ({ reconnect: vi.fn(), mayOwn: vi.fn(() => false) }));
vi.mock("../../src/auth/reconnect/runner", async (orig) => {
  const real = await orig<typeof import("../../src/auth/reconnect/runner")>();
  return {
    ...real,
    reconnectSession: (...a: Parameters<typeof real.reconnectSession>) => {
      recon.reconnect(...a);
      return real.reconnectSession(...a);
    },
  };
});
vi.mock("../../src/auth/reconnect/affinity", async (orig) => ({
  ...(await orig<typeof import("../../src/auth/reconnect/affinity")>()),
  mayOwnBrowser: () => recon.mayOwn(),
}));

import { config } from "../../src/config";
import { db } from "../../src/db";
import { installAuditContext } from "../../src/audit/context";
import { signSession } from "../../src/auth/session";
import { setApiKey } from "../../src/auth/users";
import { setUserDisabled } from "../../src/auth/user-status";
import { registerSpaceApiRoutes, containsVaultRef } from "../../src/spaces/api";
import { getSpace, setShares, toolsHash, updateSpaceMeta, upsertSpace, kvPut } from "../../src/spaces/store";
import { verifySig } from "../../src/spaces/sig";
import * as permissionsStore from "../../src/permissions/store";
import { clearPermission, setPermission } from "../../src/permissions/store";
import { deleteToken, storeToken } from "../../src/auth/tokens";
import { storeCookies } from "../../src/auth/cookie";
import { updateReconnectState } from "../../src/auth/reconnect/state";
import { registry } from "../../src/plugins/registry";
import { auditLogger } from "../../src/audit/logger";
import { _resetRateLimitForTest, _setNowForTest as setRateNow, OWNER_RATE_CAPACITY, RATE_CAPACITY } from "../../src/spaces/rate-limit";
import { handlers, registerFixtures } from "./fixtures";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "./helpers";

let app: FastifyInstance;
const tokens: Record<string, string> = {};
const TOOLS = ["acme_list_items", "acme_delete_item", "acme_unlabelled", "acme_fail", "acme_set_secret", "acmeo_list_things", "acmeo_whoami", "acmec_me"];
const prevAdmins = config.ADMIN_EMAILS;

function as(user: string) {
  return { authorization: `Bearer ${tokens[user]}` };
}

async function call(user: string, body: Record<string, unknown>, name = "s1") {
  return app.inject({ method: "POST", url: `/api/spaces/${name}/call`, headers: as(user), payload: body });
}

async function connectOauthIntegration(user: string) {
  await storeToken(user, "acme-oauth", { accessToken: "tok-abc", scopes: "" });
}

/** Everything the test Space uses: the OAuth fixture and the cookie fixture. */
async function connectAllIntegrations(user: string) {
  // Keep a token a test seeded on purpose (the delegation tests tell owner and
  // viewer apart by it).
  const has = await db.get("SELECT 1 AS n FROM connections WHERE user_id = ? AND integration = ?", [user, "acme-oauth"]);
  if (!has) await connectOauthIntegration(user);
  await storeCookies(user, "acme-cookie", {
    domain: "app.example.com",
    cookies: [{ name: "sid", value: `sid-${user}`, domain: "app.example.com", path: "/", expires: 9999999999 }],
    capturedAt: 1,
  });
}

async function disconnectOauthIntegration(user: string) {
  await db.run("DELETE FROM connections WHERE user_id = ? AND integration = ?", [user, "acme-oauth"]);
}

async function shownConsentHash(user: string, name = "s1"): Promise<string> {
  const detail = await app.inject({ method: "GET", url: `/api/spaces/${name}`, headers: as(user) });
  return detail.statusCode === 200 ? detail.json().consent_hash : "none";
}

async function revokeConsentOf(user: string, name = "s1") {
  const res = await app.inject({ method: "DELETE", url: `/api/spaces/${name}/consent`, headers: as(user) });
  expect(res.statusCode).toBe(200);
}

/** Approve what the viewer was shown (consent_hash from the detail), as a viewer who has connected everything the Space needs. */
async function consent(user: string, name = "s1") {
  await connectAllIntegrations(user);
  const consent_hash = await shownConsentHash(user, name);
  return app.inject({ method: "POST", url: `/api/spaces/${name}/consent`, headers: as(user), payload: { consent_hash } });
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
      delegate_access: false,
      delegation_suspended: false,
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
      delegable: true,
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

describe("PATCH /api/spaces/:name/sharing", () => {
  const sharing = (user: string, payload: Record<string, unknown>, name = "s1") =>
    app.inject({ method: "PATCH", url: `/api/spaces/${name}/sharing`, headers: as(user), payload });
  const shares = async () =>
    (await db.all<{ email: string }>("SELECT email FROM space_shares WHERE space_name = ? ORDER BY email", ["s1"])).map(
      (r) => r.email
    );

  it("a lost race on the write is 409 CONFLICT", async () => {
    vi.mocked(updateSpaceMeta).mockResolvedValueOnce("conflict");
    const res = await sharing("u1", { visibility: "org" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "CONFLICT", message: "This Space changed meanwhile. Try again." });
  });

  it("adds and removes people without touching anyone else", async () => {
    let res = await sharing("u1", { add_users: ["Ops@Example.com", "dev2@example.com"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      visibility: "users",
      users: ["dev2@example.com", "ops@example.com", "qa@example.com"],
      delegate_access: false,
      delegation_suspended: false,
    });
    res = await sharing("u1", { remove_users: ["dev2@example.com"] });
    expect(res.json().users).toEqual(["ops@example.com", "qa@example.com"]);
    // The newly added viewer can now open it.
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u3") })).statusCode).toBe(200);
  });

  it("opens a Space to everyone signed in and back, keeping the list", async () => {
    let res = await sharing("u1", { visibility: "org" });
    expect(res.json()).toEqual({ visibility: "org", users: ["qa@example.com"], delegate_access: false, delegation_suspended: false });
    expect((await getSpace("s1"))!.visibility).toBe("org");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u3") })).statusCode).toBe(200);
    res = await sharing("u1", { visibility: "private" });
    expect(res.json().visibility).toBe("private");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).statusCode).toBe(404);
    expect(await shares()).toEqual(["qa@example.com"]);
  });

  it("refuses to leave a 'users' Space with nobody, and writes nothing", async () => {
    const res = await sharing("u1", { remove_users: ["qa@example.com"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("USERS_REQUIRED");
    expect(await shares()).toEqual(["qa@example.com"]);
    // Switching to private while removing the last person is fine.
    const ok = await sharing("u1", { visibility: "private", remove_users: ["qa@example.com"] });
    expect(ok.json()).toEqual({ visibility: "private", users: [], delegate_access: false, delegation_suspended: false });
  });

  it("validates input before writing", async () => {
    expect((await sharing("u1", { visibility: "everyone" })).json().code).toBe("INVALID_VISIBILITY");
    const bad = await sharing("u1", { visibility: "org", add_users: ["not-an-email"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("INVALID_USERS");
    expect((await getSpace("s1"))!.visibility).toBe("users");
  });

  it("only the owner may change it: 403 for a viewer, 404 without access, 401 without a session", async () => {
    const viewer = await sharing("u2", { add_users: ["evil@example.com"] });
    expect(viewer.statusCode).toBe(403);
    expect((await sharing("u3", { visibility: "org" })).statusCode).toBe(404);
    expect((await sharing("admin", { visibility: "org" })).statusCode).toBe(404);
    const anon = await app.inject({ method: "PATCH", url: "/api/spaces/s1/sharing", payload: { visibility: "org" } });
    expect(anon.statusCode).toBe(401);
    expect(await shares()).toEqual(["qa@example.com"]);
    expect((await getSpace("s1"))!.visibility).toBe("users");
  });
});

describe("delegated access in the portal API", () => {
  const sharing = (user: string, payload: Record<string, unknown>, name = "s1") =>
    app.inject({ method: "PATCH", url: `/api/spaces/${name}/sharing`, headers: as(user), payload });
  const detail = async (user: string) => (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as(user) })).json();
  const grant = () => setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
  const delegationRows = () =>
    db.all<{ user_id: string; action: string; tool: string; error: string | null }>(
      "SELECT user_id, action, tool, error FROM audit_log WHERE action LIKE 'SPACE_DELEGATION_%' ORDER BY id"
    );
  const hashNow = async () => toolsHash((await getSpace("s1"))!.tools);
  const enable = async () => sharing("u1", { delegate_access: true, tools_hash: await hashNow() });

  beforeEach(async () => {
    await db.exec("DELETE FROM connections");
  });

  it("GET gives the owner tools_hash and can_delegate, everyone the mode and per-tool delegable", async () => {
    let owner = await detail("u1");
    expect(owner).toMatchObject({
      tools_hash: await hashNow(),
      can_delegate: false,
      delegate_access: false,
      delegation_suspended: false,
      delegation_off: null,
    });
    await grant();
    expect((await detail("u1")).can_delegate).toBe(true);
    const viewer = await detail("u2");
    expect(viewer).toMatchObject({ delegate_access: false, delegation_suspended: false, delegation_off: null });
    expect(viewer).not.toHaveProperty("tools_hash");
    expect(viewer).not.toHaveProperty("can_delegate");

    const tool = registry.getTool("acme_fail")!;
    tool.delegable = false;
    try {
      owner = await detail("u1");
      const byName = Object.fromEntries(owner.tools.map((t: any) => [t.name, t.delegable]));
      expect(byName).toMatchObject({ acme_fail: false, acme_list_items: true });
    } finally {
      delete tool.delegable;
    }
  });

  it("not granted: 403 DELEGATION_NOT_ALLOWED, nothing changed, no audit row", async () => {
    const res = await enable();
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("DELEGATION_NOT_ALLOWED");
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect(await delegationRows()).toEqual([]);
  });

  it("granted with a users audience: on, hash pinned, ON row, and the owner's connections count", async () => {
    await grant();
    await connectAllIntegrations("u1");
    const conn = (b: any) => b.tools.find((t: any) => t.name === "acmeo_list_things").connected;
    expect(conn(await detail("u2"))).toBe(false);

    const res = await enable();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ visibility: "users", users: ["qa@example.com"], delegate_access: true, delegation_suspended: false });
    const s = (await getSpace("s1"))!;
    expect(s.accessMode).toBe("owner");
    expect(s.delegatedToolsHash).toBe(toolsHash(s.tools));
    expect(await delegationRows()).toEqual([{ user_id: "u1", action: "SPACE_DELEGATION_ON", tool: "space:s1", error: null }]);
    expect(conn(await detail("u2"))).toBe(true);
    expect(await detail("u2")).toMatchObject({ delegate_access: true, delegation_off: null });
  });

  it("enabling without tools_hash is 400, with a stale one 409 TOOLS_CHANGED; neither writes", async () => {
    await grant();
    const missing = await sharing("u1", { delegate_access: true, visibility: "org" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ code: "INVALID_ARGS", message: "tools_hash is required to turn on delegated access." });
    const stale = await sharing("u1", { delegate_access: true, tools_hash: toolsHash(["acme_list_items"]), visibility: "org" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ code: "TOOLS_CHANGED", message: "The tool list changed. Review it again." });
    const s = (await getSpace("s1"))!;
    expect(s).toMatchObject({ accessMode: "viewer", visibility: "users", delegatedToolsHash: null });
    expect(await delegationRows()).toEqual([]);
  });

  it("private + delegate_access true is 403, before any write", async () => {
    await grant();
    const res = await sharing("u1", { visibility: "private", delegate_access: true, tools_hash: await hashNow() });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("DELEGATION_NOT_ALLOWED");
    expect((await getSpace("s1"))!.visibility).toBe("users");
  });

  it("delegated, then set to only me: back to viewer with a reasoned OFF row", async () => {
    await grant();
    await enable();
    const res = await sharing("u1", { visibility: "private" });
    expect(res.json()).toMatchObject({ visibility: "private", delegate_access: false });
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect((await delegationRows()).map((r) => [r.action, r.tool, r.error ?? null])).toEqual([
      ["SPACE_DELEGATION_ON", "space:s1", null],
      ["SPACE_DELEGATION_OFF", "space:s1 (reason: audience set to only me)", null],
    ]);
  });

  it("a mode-only change (on, then off) is written and audited", async () => {
    await grant();
    await enable();
    const res = await sharing("u1", { delegate_access: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: "users", delegate_access: false });
    expect((await getSpace("s1"))!).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    expect((await delegationRows()).map((r) => [r.action, r.tool, r.error ?? null])).toEqual([
      ["SPACE_DELEGATION_ON", "space:s1", null],
      ["SPACE_DELEGATION_OFF", "space:s1", null],
    ]);
    // Turning off what is already off writes nothing.
    await sharing("u1", { delegate_access: false });
    expect(await delegationRows()).toHaveLength(2);
  });

  it("a re-confirm after a tool change clears delegation_suspended and writes ON again", async () => {
    await grant();
    await connectAllIntegrations("u1");
    await enable();
    await upsertSpace({ name: "s1", ownerId: "u1", title: "Items", tools: ["acme_list_items"], visibility: "users" });
    const before = await detail("u1");
    expect(before).toMatchObject({ delegate_access: true, delegation_suspended: true, delegation_off: { reason: "tools_changed" } });
    expect(before.tools_hash).toBe(toolsHash(["acme_list_items"]));
    const res = await sharing("u1", { delegate_access: true, tools_hash: before.tools_hash });
    expect(res.json()).toMatchObject({ delegate_access: true, delegation_suspended: false });
    expect(await detail("u2")).toMatchObject({ delegation_suspended: false, delegation_off: null });
    expect((await delegationRows()).map((r) => r.action)).toEqual(["SPACE_DELEGATION_ON", "SPACE_DELEGATION_ON"]);
  });

  it("the list carries the mode and the pause: stored for the owner, effective for others", async () => {
    const list = async (user: string) =>
      (await app.inject({ method: "GET", url: "/api/spaces", headers: as(user) })).json().spaces.find((s: any) => s.name === "s1");
    expect(await list("u2")).toMatchObject({ delegate_access: false, delegation_suspended: false });
    await grant();
    await enable();
    expect(await list("u1")).toMatchObject({ delegate_access: true, delegation_suspended: false });
    expect(await list("u2")).toMatchObject({ delegate_access: true, delegation_suspended: false });
    // Tool list changed: paused for both.
    await upsertSpace({ name: "s1", ownerId: "u1", title: "Items", tools: ["acme_list_items"], visibility: "users" });
    expect(await list("u1")).toMatchObject({ delegate_access: true, delegation_suspended: true });
    expect(await list("u2")).toMatchObject({ delegate_access: false, delegation_suspended: true });
    // Permission revoked: the owner still sees the stored mode, a viewer sees it off.
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    await upsertSpace({ name: "s1", ownerId: "u1", title: "Items", tools: TOOLS, visibility: "users" });
    expect(await list("u1")).toMatchObject({ delegate_access: true, delegation_suspended: false, delegation_blocked: "no_permission" });
    expect(await list("u2")).toMatchObject({ delegate_access: false, delegation_suspended: false });
    expect(await list("u2")).not.toHaveProperty("delegation_blocked");
  });

  it("a revoked permission shows as off to everyone, not as the viewer's access", async () => {
    await grant();
    await enable();
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    const viewer = await detail("u2");
    // Effective for a viewer: they cannot tell the owner lost the permission.
    expect(viewer).toMatchObject({ delegate_access: false, delegation_suspended: false });
    expect(viewer.delegation_off).toEqual({ reason: "turned_off", message: "This Space's shared access was turned off." });
    // The owner sees the stored mode, and why it is off.
    expect(await detail("u1")).toMatchObject({
      delegate_access: true,
      can_delegate: false,
      delegation_blocked: "no_permission",
      delegation_off: { reason: "turned_off" },
    });
    expect(viewer).not.toHaveProperty("delegation_blocked");
  });

  it("delegation_blocked is absent while the owner holds the permission", async () => {
    await grant();
    await enable();
    expect(await detail("u1")).not.toHaveProperty("delegation_blocked");
  });

  it("a people-only edit while blocked leaves the stored mode and pin alone", async () => {
    await grant();
    await enable();
    const before = (await getSpace("s1"))!;
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    const res = await sharing("u1", { add_users: ["new@example.com"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delegate_access: true, delegation_blocked: "no_permission" });
    const after = (await getSpace("s1"))!;
    expect(after.accessMode).toBe("owner");
    expect(after.delegatedToolsHash).toBe(before.delegatedToolsHash);
    expect((await delegationRows()).map((r) => r.action)).toEqual(["SPACE_DELEGATION_ON"]);
  });

  it("widening the audience while blocked turns the mode off and audits the reason", async () => {
    await grant();
    await enable();
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    const res = await sharing("u1", { visibility: "org" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: "org", delegate_access: false });
    expect(res.json()).not.toHaveProperty("delegation_blocked");
    const s = (await getSpace("s1"))!;
    expect(s.accessMode).toBe("viewer");
    expect(s.delegatedToolsHash).toBeNull();
    expect((await delegationRows()).slice(1)).toEqual([
      { user_id: "u1", action: "SPACE_DELEGATION_OFF", tool: "space:s1 (reason: audience widened without permission)", error: null },
    ]);
  });

  it("the list reads the owner's permission once per request", async () => {
    await grant();
    await enable();
    await upsertSpace({ name: "s2", ownerId: "u1", title: "Two", tools: TOOLS, visibility: "users" });
    writeSpaceFiles(tmp, "s2", { "index.html": "x" });
    await db.run("UPDATE spaces SET access_mode = 'owner', delegated_tools_hash = ? WHERE name = 's2'", [toolsHash(TOOLS)]);
    const spy = vi.spyOn(permissionsStore, "can");
    try {
      await app.inject({ method: "GET", url: "/api/spaces", headers: as("u1") });
      expect(spy.mock.calls.filter((c) => c[1] === "spaces.delegate_access")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("a no-op re-confirm (and a double submit) writes nothing and audits once", async () => {
    await grant();
    vi.mocked(updateSpaceMeta).mockClear();
    const first = await enable();
    const second = await enable();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(vi.mocked(updateSpaceMeta)).toHaveBeenCalledTimes(1);
    const third = await sharing("u1", { delegate_access: true, tools_hash: await hashNow(), visibility: "users" });
    expect(third.json()).toMatchObject({ delegate_access: true, delegation_suspended: false });
    expect(vi.mocked(updateSpaceMeta)).toHaveBeenCalledTimes(1);
    expect((await delegationRows()).map((r) => r.action)).toEqual(["SPACE_DELEGATION_ON"]);
    // Already on, with an audience change: the audience is written, no new ON row.
    const widened = await sharing("u1", { delegate_access: true, tools_hash: await hashNow(), visibility: "org" });
    expect(widened.json()).toMatchObject({ visibility: "org", delegate_access: true });
    expect(await getSpace("s1")).toMatchObject({ visibility: "org", accessMode: "owner" });
    expect((await delegationRows()).map((r) => r.action)).toEqual(["SPACE_DELEGATION_ON"]);
  });

  it("delegate_access true with a visibility change org -> users enables and audits once", async () => {
    await grant();
    await sharing("u1", { visibility: "org" });
    const res = await sharing("u1", { visibility: "users", delegate_access: true, tools_hash: await hashNow() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ visibility: "users", delegate_access: true });
    expect(await getSpace("s1")).toMatchObject({ visibility: "users", accessMode: "owner" });
    expect((await delegationRows()).map((r) => r.action)).toEqual(["SPACE_DELEGATION_ON"]);
  });

  it("a failed audit write after the mode is saved does not fail the request", async () => {
    await grant();
    vi.spyOn(auditLogger, "log").mockRejectedValue(new Error("audit store down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const on = await enable();
    expect(on.statusCode).toBe(200);
    expect((await getSpace("s1"))!.accessMode).toBe("owner");
    const off = await sharing("u1", { visibility: "private" });
    expect(off.statusCode).toBe(200);
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect(err).toHaveBeenCalledTimes(2);
  });

  it("validates delegate_access and tools_hash, and only the owner may set them", async () => {
    await grant();
    const bad = await sharing("u1", { delegate_access: "yes" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("INVALID_ARGS");
    expect((await sharing("u1", { delegate_access: true, tools_hash: 5 })).json().code).toBe("INVALID_ARGS");
    const viewer = await sharing("u2", { delegate_access: true, tools_hash: await hashNow() });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().code).toBe("FORBIDDEN");
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect(await delegationRows()).toEqual([]);
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

  const delegate = async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(TOOLS) });
  };
  const approveAs = async (user: string) =>
    app.inject({ method: "POST", url: "/api/spaces/s1/consent", headers: as(user), payload: { consent_hash: await shownConsentHash(user) } });
  const detailOf = async (user: string) => (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as(user) })).json();

  it("a delegated Space with the owner connected: the viewer approves and calls with no connection of their own", async () => {
    await delegate();
    await connectAllIntegrations("u1");
    // u2 has connected nothing.
    expect(await detailOf("u2")).toMatchObject({ delegate_access: true, delegation_off: null, consented: false });
    expect((await approveAs("u2")).json()).toEqual({ ok: true });
    expect((await detailOf("u2")).consented).toBe(true);
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: { token: "tok-abc" } });
    expect(await db.all("SELECT user_id FROM connections WHERE user_id = ?", ["u2"])).toEqual([]);

    // Back to the viewer's own connections: the viewer's gate applies again.
    await updateSpaceMeta("s1", "u1", { accessMode: "viewer" });
    const refused = await approveAs("u2");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("INTEGRATION_NOT_CONNECTED");
  });

  it("a delegated Space whose owner lacks a connection: the viewer is held at the gate, consented or not", async () => {
    await delegate();
    await connectAllIntegrations("u1");
    // Consent first, while the owner is connected, so the call path is tested with consent in place.
    expect((await approveAs("u2")).json()).toEqual({ ok: true });
    await disconnectOauthIntegration("u1");
    // The viewer's own connections are never what is checked.
    await connectAllIntegrations("u2");

    const message = "dev@example.com needs to reconnect Acme OAuth before this Space can be used.";
    const viewer = await detailOf("u2");
    expect(viewer).toMatchObject({ delegate_access: true, delegation_suspended: false, consented: true });
    expect(viewer.delegation_off).toEqual({ reason: "owner_not_connected", message });

    await revokeConsentOf("u2");
    const refused = await approveAs("u2");
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ code: "OWNER_NOT_CONNECTED", message });
    expect((await detailOf("u2")).consented).toBe(false);

    // Reconnected: the gate lifts.
    await connectOauthIntegration("u1");
    expect((await detailOf("u2")).delegation_off).toBeNull();
    expect((await approveAs("u2")).json()).toEqual({ ok: true });
  });

  it("the gate names each integration the owner is missing, once each", async () => {
    await delegate();
    const viewer = await detailOf("u2");
    expect(viewer.delegation_off).toEqual({
      reason: "owner_not_connected",
      message: "dev@example.com needs to reconnect Acme Cookie, Acme OAuth before this Space can be used.",
    });
  });

  it("the owner opening their own delegated Space gets their own connect gate, not the delegated one", async () => {
    await delegate();
    const owner = await detailOf("u1");
    expect(owner.delegation_off).toBeNull();
    const refused = await approveAs("u1");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("INTEGRATION_NOT_CONNECTED");
    expect(refused.json().message).toContain("Acme OAuth");
  });

  it("an ordinary Space ignores the owner's connections: only the viewer's count", async () => {
    // Owner connected to nothing, viewer to everything.
    await connectAllIntegrations("u2");
    expect((await detailOf("u2")).delegation_off).toBeNull();
    expect((await approveAs("u2")).json()).toEqual({ ok: true });
  });

  it("POST refuses with 409 until every integration the Space uses is connected", async () => {
    const refused = await app.inject({ method: "POST", url: "/api/spaces/s1/consent", headers: as("u2"), payload: { consent_hash: await shownConsentHash("u2") } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "INTEGRATION_NOT_CONNECTED" });
    expect(refused.json().message).toContain("Acme OAuth");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(false);

    await connectAllIntegrations("u2");
    const ok = await app.inject({ method: "POST", url: "/api/spaces/s1/consent", headers: as("u2"), payload: { consent_hash: await shownConsentHash("u2") } });
    expect(ok.json()).toEqual({ ok: true });
  });

  it("binds the approval to what the viewer was shown: consent_hash, 409 CONSENT_CHANGED otherwise", async () => {
    await connectAllIntegrations("u2");
    const post = (payload?: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/spaces/s1/consent", headers: as("u2"), ...(payload ? { payload } : {}) });
    const shown = (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consent_hash;
    expect(shown).toMatch(/^[0-9a-f]{64}$/);

    for (const res of [await post(), await post({}), await post({ consent_hash: 42 }), await post({ consent_hash: "0".repeat(64) })]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ code: "CONSENT_CHANGED", message: "This Space changed. Review it again." });
    }
    // The Space changes between showing the screen and approving it.
    await updateSpaceMeta("s1", "u1", { tools: [...TOOLS, "acme_extra"] });
    expect((await post({ consent_hash: shown })).json().code).toBe("CONSENT_CHANGED");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(false);

    const now = (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consent_hash;
    expect(now).not.toBe(shown);
    expect((await post({ consent_hash: now })).json()).toEqual({ ok: true });
  });

  it("consent_hash is per viewer: the owner's ignores the access mode", async () => {
    const hashOf = async (user: string) => (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as(user) })).json().consent_hash;
    const owner = await hashOf("u1");
    const viewer = await hashOf("u2");
    expect(owner).not.toBe(viewer);
    await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(TOOLS) });
    expect(await hashOf("u1")).toBe(owner);
    expect(await hashOf("u2")).not.toBe(viewer);
  });

  it("a change of access mode invalidates it, both ways", async () => {
    await consent("u2");
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
    await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(TOOLS) });
    const flipped = await call("u2", { tool: "acme_list_items" });
    expect(flipped.statusCode).toBe(403);
    expect(flipped.json().code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u2") })).json().consented).toBe(false);

    await consent("u2");
    await updateSpaceMeta("s1", "u1", { accessMode: "viewer" });
    const back = await call("u2", { tool: "acme_list_items" });
    expect(back.statusCode).toBe(403);
    expect(back.json().code).toBe("CONSENT_REQUIRED");
  });

  it("the owner keeps consent when they turn delegation on and off from the portal", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    await consent("u1");
    const detail = async () => (await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u1") })).json();
    const sharing = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: "/api/spaces/s1/sharing", headers: as("u1"), payload });
    const kv = () => app.inject({ method: "GET", url: "/api/spaces/s1/kv", headers: as("u1") });

    expect((await sharing({ delegate_access: true, tools_hash: (await detail()).tools_hash })).statusCode).toBe(200);
    expect((await detail()).consented).toBe(true);
    expect((await call("u1", { tool: "acme_list_items" })).json().code).not.toBe("CONSENT_REQUIRED");
    expect((await kv()).statusCode).toBe(200);

    expect((await sharing({ delegate_access: false })).statusCode).toBe(200);
    expect((await detail()).consented).toBe(true);
    expect((await call("u1", { tool: "acme_list_items" })).json().code).not.toBe("CONSENT_REQUIRED");
    expect((await kv()).statusCode).toBe(200);
  });

  it("the owner is re-asked when the tool list changes", async () => {
    await consent("u1");
    await updateSpaceMeta("s1", "u1", { tools: [...TOOLS, "acme_extra"] });
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1", headers: as("u1") })).json().consented).toBe(false);
    const res = await call("u1", { tool: "acme_list_items" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("CONSENT_REQUIRED");
    expect((await app.inject({ method: "GET", url: "/api/spaces/s1/kv", headers: as("u1") })).json().code).toBe("CONSENT_REQUIRED");
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
    await disconnectOauthIntegration("u2");
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
    // The limiter runs before the delegation, confirmation and argument
    // checks, so a looping page cannot get unlimited refusals either.
    expect((await call("u2", { tool: "acme_list_items", args: { q: "{{vault:x}}" } })).statusCode).toBe(429);
    // Another viewer has their own bucket.
    expect((await call("u1", { tool: "acme_list_items" })).statusCode).toBe(200);
    t += 1000;
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(200);
  });

  it("8. outcome mapping: NOT_CONNECTED 409, bad args 400, upstream 502", async () => {
    await consent("u2");
    await disconnectOauthIntegration("u2");
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

describe("POST /api/spaces/:name/call, delegated", () => {
  const VIEWERS: Array<[string, string]> = [
    ["u2", "qa@example.com"],
    ["u3", "ops@example.com"],
    ["u4", "v4@example.com"],
    ["u5", "v5@example.com"],
    ["u6", "v6@example.com"],
    ["u7", "v7@example.com"],
  ];
  const grant = () => setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
  const sharing = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/api/spaces/s1/sharing", headers: as("u1"), payload });
  const enable = async () => {
    const res = await sharing({ delegate_access: true, tools_hash: toolsHash((await getSpace("s1"))!.tools) });
    expect(res.statusCode).toBe(200);
  };
  const executeRows = () =>
    db.all<{ user_id: string; actor_user_id: string | null; client_name: string | null; tool: string; success: unknown; error: string | null }>(
      "SELECT user_id, actor_user_id, client_name, tool, success, error FROM audit_log WHERE action = 'EXECUTE' ORDER BY id"
    );
  const row = (r: { success: unknown }) => ({ ...r, success: Boolean(Number(r.success)) });

  beforeEach(async () => {
    await db.exec("DELETE FROM connections");
    for (const [id, email] of VIEWERS.slice(2)) {
      await seedUser(id, email);
      tokens[id] = await signSession({ userId: id, email });
    }
    await setShares("s1", "u1", VIEWERS.map(([, e]) => e));
    await grant();
    await enable();
    // The owner is connected to everything the Space uses, or the viewers
    // could not get past the delegated gate.
    await storeToken("u1", "acme-oauth", { accessToken: "tok-owner", scopes: "" });
    await connectAllIntegrations("u1");
    for (const [id] of VIEWERS) expect((await consent(id)).statusCode).toBe(200);
    await storeToken("u2", "acme-oauth", { accessToken: "tok-viewer", scopes: "" });
    await db.exec("DELETE FROM audit_log");
  });

  it("1. runs with the owner's token, audited as the owner with the viewer as actor", async () => {
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: { token: "tok-owner" } });
    expect((await executeRows()).map(row)).toEqual([
      { user_id: "u1", actor_user_id: "u2", client_name: "space:s1", tool: "acmeo_whoami", success: true, error: null },
    ]);
  });

  it("2. not delegated: the viewer's own token, no actor; a not-delegable tool runs as before", async () => {
    expect((await sharing({ delegate_access: false })).statusCode).toBe(200);
    await consent("u2");
    await db.exec("DELETE FROM audit_log");
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.json()).toEqual({ result: { token: "tok-viewer" } });
    expect((await call("u2", { tool: "acme_set_secret" })).statusCode).toBe(200);
    expect((await executeRows()).map(row)).toEqual([
      { user_id: "u2", actor_user_id: null, client_name: "space:s1", tool: "acmeo_whoami", success: true, error: null },
      { user_id: "u2", actor_user_id: null, client_name: "space:s1", tool: "acme_set_secret", success: true, error: null },
    ]);
  });

  it("the owner calling their own delegated Space uses their access, not delegation", async () => {
    await consent("u1");
    const res = await call("u1", { tool: "acmeo_whoami" });
    expect(res.json()).toEqual({ result: { token: "tok-owner" } });
    expect((await call("u1", { tool: "acme_set_secret" })).statusCode).toBe(200);
    expect((await executeRows()).every((r) => r.user_id === "u1" && r.actor_user_id === null)).toBe(true);
  });

  it("3. owner disconnected while the viewer is connected: 409 OWNER_NOT_CONNECTED for every tool, nothing runs, audited", async () => {
    const whoami = vi.spyOn(handlers, "whoami");
    const list = vi.spyOn(handlers, "list");
    await deleteToken("u1", "acme-oauth");
    const message = "dev@example.com needs to reconnect Acme OAuth before this Space can be used.";
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: "OWNER_NOT_CONNECTED",
      reason: "owner_not_connected",
      message,
      integration: "acme-oauth",
      tool: "acmeo_whoami",
    });
    // A tool of an integration the owner has connected is refused too: the Space is closed.
    const other = await call("u2", { tool: "acme_list_items" });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ code: "OWNER_NOT_CONNECTED", message, integration: "acme", tool: "acme_list_items" });
    expect(whoami).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect((await executeRows()).map(row)).toEqual([
      { user_id: "u1", actor_user_id: "u2", client_name: "space:s1", tool: "acmeo_whoami", success: false, error: "OWNER_NOT_CONNECTED" },
      { user_id: "u1", actor_user_id: "u2", client_name: "space:s1", tool: "acme_list_items", success: false, error: "OWNER_NOT_CONNECTED" },
    ]);
  });

  it("3a. the owner calling their own delegated Space is not held by the delegated gate", async () => {
    await consent("u1");
    await deleteToken("u1", "acme-oauth");
    await db.exec("DELETE FROM audit_log");
    expect((await call("u1", { tool: "acme_list_items" })).statusCode).toBe(200);
    const res = await call("u1", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("NOT_CONNECTED");
    expect(res.json()).not.toHaveProperty("delegated");
  });

  it("3b. owner's grant dead (expired, no refresh token): 409 delegated, never the viewer's token", async () => {
    await storeToken("u1", "acme-oauth", { accessToken: "tok-owner", scopes: "", expiresAt: 1 });
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "NOT_CONNECTED", delegated: true, message: "dev@example.com needs to reconnect Acme OAuth." });
  });

  const expectRefusedRow = async (tool: string, error: string) =>
    expect((await executeRows()).map(row)).toEqual([
      { user_id: "u1", actor_user_id: "u2", client_name: "space:s1", tool, success: false, error },
    ]);

  it("4. grant revoked: 403 DELEGATION_OFF turned_off, the tool never runs, audited with both ids", async () => {
    const whoami = vi.spyOn(handlers, "whoami");
    await clearPermission("u1", "spaces.delegate_access");
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "DELEGATION_OFF",
      reason: "turned_off",
      message: "This Space's shared access was turned off.",
      integration: "acme-oauth",
      tool: "acmeo_whoami",
    });
    expect(whoami).not.toHaveBeenCalled();
    await expectRefusedRow("acmeo_whoami", "DELEGATION_OFF");
  });

  it("5. owner disabled, or owner row gone: DELEGATION_OFF", async () => {
    await setUserDisabled("u1", true);
    let res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "DELEGATION_OFF", reason: "turned_off" });
    await expectRefusedRow("acmeo_whoami", "DELEGATION_OFF");

    await setUserDisabled("u1", false);
    await db.run("DELETE FROM users WHERE id = ?", ["u1"]);
    await db.exec("DELETE FROM audit_log");
    res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "DELEGATION_OFF", reason: "turned_off" });
    await expectRefusedRow("acmeo_whoami", "DELEGATION_OFF");
  });

  it("6. tools changed after enable: DELEGATION_OFF tools_changed", async () => {
    await db.run("UPDATE spaces SET tools = ? WHERE name = ?", [JSON.stringify([...TOOLS].sort().slice(1)), "s1"]);
    await consent("u2");
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: "DELEGATION_OFF",
      reason: "tools_changed",
      message: "This Space's tools changed. The owner needs to confirm them again.",
    });
    await expectRefusedRow("acmeo_whoami", "DELEGATION_OFF");
  });

  it("7. a tool marked not delegable: 403 TOOL_NOT_DELEGABLE, never runs, audited", async () => {
    const setSecret = vi.spyOn(handlers, "setSecret");
    const res = await call("u2", { tool: "acme_set_secret" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      code: "TOOL_NOT_DELEGABLE",
      message: "acme_set_secret cannot run with someone else's access.",
      integration: "acme",
      tool: "acme_set_secret",
    });
    expect(setSecret).not.toHaveBeenCalled();
    await expectRefusedRow("acme_set_secret", "TOOL_NOT_DELEGABLE");
  });

  it("8. an undeclared tool is TOOL_NOT_DECLARED as before, even when delegation is off", async () => {
    await clearPermission("u1", "spaces.delegate_access");
    const res = await call("u2", { tool: "acme_ghost" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("TOOL_NOT_DECLARED");
    expect(await executeRows()).toEqual([]);
  });

  it("9. vault references, bad args and unconfirmed destructive calls are refused, and audited", async () => {
    const vault = await call("u2", { tool: "acmeo_whoami", args: { q: "{{vault:pw}}" } });
    expect(vault.statusCode).toBe(400);
    expect(vault.json()).toMatchObject({ code: "INVALID_ARGS", message: "Vault references are not allowed in a Space." });
    const notObject = await call("u2", { tool: "acmeo_whoami", args: [1] });
    expect(notObject.statusCode).toBe(400);
    expect(notObject.json()).toMatchObject({ code: "INVALID_ARGS", message: "args must be an object." });
    const unconfirmed = await call("u2", { tool: "acme_delete_item", args: { id: "1" } });
    expect(unconfirmed.statusCode).toBe(428);
    expect(unconfirmed.json().code).toBe("CONFIRMATION_REQUIRED");
    const confirmed = await call("u2", { tool: "acme_delete_item", args: { id: "1" }, confirmed: true });
    expect(confirmed.statusCode).toBe(200);
    const both = { user_id: "u1", actor_user_id: "u2", client_name: "space:s1" };
    expect((await executeRows()).map(row)).toEqual([
      { ...both, tool: "acmeo_whoami", success: false, error: "INVALID_ARGS" },
      { ...both, tool: "acmeo_whoami", success: false, error: "INVALID_ARGS" },
      { ...both, tool: "acme_delete_item", success: false, error: "CONFIRMATION_REQUIRED" },
      { ...both, tool: "acme_delete_item", success: true, error: null },
    ]);
  });

  it("9b. not delegated, the same refusals write no audit row", async () => {
    expect((await sharing({ delegate_access: false })).statusCode).toBe(200);
    await consent("u2");
    await db.exec("DELETE FROM audit_log");
    expect((await call("u2", { tool: "acmeo_whoami", args: { q: "{{vault:pw}}" } })).statusCode).toBe(400);
    expect((await call("u2", { tool: "acmeo_whoami", args: [1] })).statusCode).toBe(400);
    expect((await call("u2", { tool: "acme_delete_item", args: { id: "1" } })).statusCode).toBe(428);
    expect(await executeRows()).toEqual([]);
  });

  it("a failed audit write on a refusal is logged, and the refusal still answers", async () => {
    vi.spyOn((auditLogger as any).destination, "log").mockRejectedValue(new Error("audit store down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await clearPermission("u1", "spaces.delegate_access");
    const res = await call("u2", { tool: "acmeo_whoami" });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("DELEGATION_OFF");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain("audit store down");
  });

  describe("cookie auto-reconnect", () => {
    const COOKIE = "acme-cookie";
    const seedSession = (user: string) =>
      storeCookies(user, COOKIE, {
        domain: "app.example.com",
        cookies: [{ name: "sid", value: `sid-${user}`, domain: "app.example.com", path: "/", expires: 9999999999 }],
        capturedAt: 1,
      });

    beforeEach(() => {
      recon.reconnect.mockClear();
      recon.mayOwn.mockClear();
    });

    it("owner's session known dead: the Space is held at the owner gate, the reconnect runner never starts", async () => {
      await seedSession("u1");
      await updateReconnectState("u1", COOKIE, { deadAt: Date.now() });
      await seedSession("u2");
      const res = await call("u2", { tool: "acmec_me" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        code: "OWNER_NOT_CONNECTED",
        reason: "owner_not_connected",
        message: "dev@example.com needs to reconnect Acme Cookie before this Space can be used.",
        integration: COOKIE,
        tool: "acmec_me",
      });
      expect(recon.reconnect).not.toHaveBeenCalled();
      expect(recon.mayOwn).not.toHaveBeenCalled();
    });

    it("owner's session dies during the call: the dead response is kept, no reconnect, one request", async () => {
      await seedSession("u1");
      const fetchMock = vi.fn(async () => new Response("no", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);
      try {
        const res = await call("u2", { tool: "acmec_me" });
        expect(res.statusCode).toBe(502);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(new Headers((fetchMock.mock.calls[0] as any)[1].headers).get("cookie")).toBe("sid=sid-u1");
      } finally {
        vi.unstubAllGlobals();
      }
      expect(recon.reconnect).not.toHaveBeenCalled();
      expect(recon.mayOwn).not.toHaveBeenCalled();
    });

    it("control: not delegated, the viewer's own dead session does start the runner", async () => {
      expect((await sharing({ delegate_access: false })).statusCode).toBe(200);
      await consent("u2");
      await seedSession("u2");
      await updateReconnectState("u2", COOKIE, { deadAt: Date.now() });
      const res = await call("u2", { tool: "acmec_me" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).not.toHaveProperty("delegated");
      expect(recon.mayOwn).toHaveBeenCalledTimes(1);
    });
  });

  it("10. KV stays per viewer", async () => {
    const put = (u: string, v: unknown) =>
      app.inject({ method: "PUT", url: "/api/spaces/s1/kv/k", headers: as(u), payload: { value: v } });
    const get = async (u: string) => (await app.inject({ method: "GET", url: "/api/spaces/s1/kv/k", headers: as(u) })).json();
    expect((await put("u2", "two")).statusCode).toBe(200);
    expect((await put("u3", "three")).statusCode).toBe(200);
    expect(await get("u2")).toEqual({ value: "two" });
    expect(await get("u3")).toEqual({ value: "three" });
  });

  it("11. owner bucket: 300 per minute across all viewers, then 429, not audited", async () => {
    const t = 7_000_000;
    setRateNow(() => t);
    // Five viewers use up their own 60 each: 300 on the owner's bucket.
    expect(OWNER_RATE_CAPACITY / RATE_CAPACITY).toBe(5);
    for (const [id] of VIEWERS.slice(0, 5)) {
      for (let i = 0; i < RATE_CAPACITY; i++) expect((await call(id, { tool: "acme_list_items" })).statusCode).toBe(200);
    }
    await db.exec("DELETE FROM audit_log");
    // A sixth viewer, with a full bucket of their own, is held by the owner's.
    const over = await call("u7", { tool: "acme_list_items" });
    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 200 });
    // Rate limiting is the one refusal not audited: it is what bounds the log.
    expect(await executeRows()).toEqual([]);
  });

  it("a delegated viewer's own 429 writes no audit row", async () => {
    const t = 8_000_000;
    setRateNow(() => t);
    for (let i = 0; i < RATE_CAPACITY; i++) await call("u2", { tool: "acme_list_items" });
    await db.exec("DELETE FROM audit_log");
    expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(429);
    expect(await executeRows()).toEqual([]);
  });

  it("a viewer looping on a paused Space is rate limited: 60 audited refusals, then 429s with no rows", async () => {
    const t = 9_000_000;
    setRateNow(() => t);
    await upsertSpace({ name: "s1", ownerId: "u1", title: "Items", tools: [...TOOLS, "acme_extra"], visibility: "users" });
    // The tool change also asks for consent again; approve the new list.
    expect((await consent("u2")).statusCode).toBe(200);
    for (let i = 0; i < RATE_CAPACITY; i++) {
      const r = await call("u2", { tool: "acme_list_items" });
      expect(r.json()).toMatchObject({ code: "DELEGATION_OFF", reason: "tools_changed" });
    }
    for (let i = 0; i < 20; i++) expect((await call("u2", { tool: "acme_list_items" })).statusCode).toBe(429);
    const rows = await executeRows();
    expect(rows).toHaveLength(RATE_CAPACITY);
    expect(new Set(rows.map((r) => r.error))).toEqual(new Set(["DELEGATION_OFF"]));
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
