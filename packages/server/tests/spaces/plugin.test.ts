import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
vi.mock("../../src/spaces/dir", () => ({ spacesRoot: () => tmp }));
// getSpace passes through, but a test can make the handler's ownership check
// see a stale row (the race between check and write).
vi.mock("../../src/spaces/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/spaces/store")>();
  return { ...actual, getSpace: vi.fn(actual.getSpace), updateSpaceMeta: vi.fn(actual.updateSpaceMeta) };
});

import { config } from "../../src/config";
import { db } from "../../src/db";
import { consume } from "../../src/spaces/pending";
import { getShares, getSpace, grantConsent, kvPut, toolsHash, updateSpaceMeta } from "../../src/spaces/store";
import { setPermission } from "../../src/permissions/store";
import { auditLogger } from "../../src/audit/logger";
import { spacesPlugin } from "../../src/plugins/internal/spaces";
import { INTERNAL_PLUGIN_NAMES } from "../../src/plugins/internal-names";
import { registerInternalPlugins } from "../../src/plugins/loader";
import { registry } from "../../src/plugins/registry";
import { registerFixtures, spacesTool } from "./fixtures";
import { resetSpacesDb, seedUser, writeSpaceFiles } from "./helpers";

const deploy = spacesTool("deploy_space");
const update = spacesTool("update_space");
const list = spacesTool("list_spaces");
const files = spacesTool("list_space_files");
const del = spacesTool("delete_space");

const prevAdmins = config.ADMIN_EMAILS;
beforeAll(() => registerFixtures());
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spaces-plugin-"));
  await resetSpacesDb();
  await seedUser("u1", "dev@example.com");
  await seedUser("u2", "qa@example.com");
  await seedUser("admin", "admin@example.com");
  config.ADMIN_EMAILS = ["admin@example.com"];
});
afterEach(() => {
  config.ADMIN_EMAILS = prevAdmins;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ok = { name: "s1", title: "Items", tools: ["acme_list_items"], visibility: "org" };

describe("spaces plugin", () => {
  it("is internal, registered by registerInternalPlugins, with effect labels", () => {
    expect(INTERNAL_PLUGIN_NAMES).toContain("spaces");
    registerInternalPlugins();
    expect(registry.getTool("deploy_space")?.integration).toBe("spaces");
    const effects = Object.fromEntries(spacesPlugin.tools.map((t) => [t.name, t.effect]));
    expect(effects).toEqual({
      deploy_space: "write",
      update_space: "write",
      list_spaces: "read",
      list_space_files: "read",
      delete_space: "destructive",
    });
    expect(spacesPlugin.integration.auth.type).toBe("none");
  });

  it("deploy_space description teaches how to build a Space", () => {
    const d = spacesPlugin.tools.find((t) => t.name === "deploy_space")!.description;
    expect(d).toContain('<script src="/s/_sdk/workbench.js"></script>');
    expect(d).toContain("workbench.call");
    expect(d).toContain("connect-src 'none'");
    expect(d).toMatch(/bundle or inline every asset/);
    expect(d).toContain("--data-binary @- -H 'Content-Type: application/gzip'");
  });

  it("deploy_space saves metadata, shares, and mints a replace token", async () => {
    const r = await deploy("u1", { ...ok, tools: ["acme_list_items", "acmeo_list_things", "acme_list_items"], visibility: "users", users: ["QA@example.com"] });
    expect(r.uploadUrl).toBe(`${config.SERVER_PUBLIC_URL}/s/upload/${r.token}`);
    expect(r.url).toBe(`${config.PORTAL_URL}/s/s1`);
    expect(r.maxBytes).toBe(config.JOTS_MAX_BYTES);
    expect(typeof r.expiresAt).toBe("number");
    const s = await getSpace("s1");
    expect(s).toMatchObject({ ownerId: "u1", title: "Items", visibility: "users", tools: ["acme_list_items", "acmeo_list_things"] });
    expect(await getShares("s1")).toEqual(["qa@example.com"]);
    expect(await consume(r.token)).toMatchObject({ owner: "u1", name: "s1", mode: "replace" });
  });

  it("deploy_space validation errors", async () => {
    expect((await deploy("u1", { ...ok, name: "Bad Name" })).error).toBe("INVALID_NAME");
    expect((await deploy("u1", { ...ok, name: "upload" })).error).toBe("INVALID_NAME");
    expect((await deploy("u1", { ...ok, name: "_sdk" })).error).toBe("INVALID_NAME");
    expect((await deploy("u1", { ...ok, visibility: "users" })).error).toBe("USERS_REQUIRED");
    expect((await deploy("u1", { ...ok, visibility: "users", users: [] })).error).toBe("USERS_REQUIRED");
    expect((await deploy("u1", { ...ok, visibility: "users", users: ["not-an-email"] })).error).toBe("INVALID_USERS");
    expect(await getSpace("s1")).toBeNull();
  });

  it("deploy_space refuses internal, unknown and custom-app tools by integration", async () => {
    for (const tool of ["deploy_jot", "list_spaces", "nope_tool", "myapp__search"]) {
      const r = await deploy("u1", { ...ok, tools: [tool] });
      expect(r.error).toBe("TOOL_NOT_ALLOWED");
      expect(r.tool).toBe(tool);
    }
    expect(await getSpace("s1")).toBeNull();
  });

  it("names are creator-locked", async () => {
    await deploy("u1", ok);
    expect((await deploy("u2", ok)).error).toBe("SPACE_NAME_TAKEN");
    expect((await deploy("u1", { ...ok, title: "Again" })).uploadUrl).toBeTruthy();
  });

  it("update_space applies metadata at once and mints a patch token only when asked", async () => {
    await deploy("u1", ok);
    const r = await update("u1", { name: "s1", title: "Renamed", tools: ["acme_delete_item"] });
    expect(r.applied).toMatchObject({ title: "Renamed", tools: ["acme_delete_item"], visibility: "org" });
    expect(r.uploadUrl).toBeUndefined();
    expect((await getSpace("s1"))!.tools).toEqual(["acme_delete_item"]);

    const p = await update("u1", { name: "s1", files: true, delete: ["old.js"] });
    expect(await consume(p.token)).toMatchObject({ mode: "patch", deletes: ["old.js"] });
    expect((await update("u1", { name: "s1", delete: ["../x"] })).error).toBe("INVALID_PATH");
  });

  it("update_space checks ownership and validates before changing anything", async () => {
    await deploy("u1", ok);
    expect((await update("u2", { name: "s1", title: "x" })).error).toBe("FORBIDDEN");
    expect((await update("u1", { name: "missing" })).error).toBe("NOT_FOUND");
    expect((await update("u1", { name: "s1", title: "x", tools: ["deploy_jot"] })).error).toBe("TOOL_NOT_ALLOWED");
    expect((await update("u1", { name: "s1", visibility: "users" })).error).toBe("USERS_REQUIRED");
    expect((await getSpace("s1"))!.title).toBe("Items");
    const r = await update("u1", { name: "s1", visibility: "users", users: ["qa@example.com"] });
    expect(r.applied.users).toEqual(["qa@example.com"]);
  });

  it("update_space reports a lost race as CONFLICT, not FORBIDDEN", async () => {
    await deploy("u1", ok);
    vi.mocked(updateSpaceMeta).mockResolvedValueOnce("conflict");
    const r = await update("u1", { name: "s1", title: "x" });
    expect(r).toMatchObject({ error: "CONFLICT" });
    expect(r.message).toMatch(/changed meanwhile/);
  });

  it("update_space add_users / remove_users change one person and keep the rest", async () => {
    await deploy("u1", { ...ok, visibility: "users", users: ["qa@example.com", "ops@example.com"] });
    const added = await update("u1", { name: "s1", add_users: ["New@Example.com"] });
    expect(added.applied.users).toEqual(["new@example.com", "ops@example.com", "qa@example.com"]);
    const removed = await update("u1", { name: "s1", remove_users: ["ops@example.com"] });
    expect(removed.applied.users).toEqual(["new@example.com", "qa@example.com"]);
    expect(await getShares("s1")).toEqual(["new@example.com", "qa@example.com"]);
  });

  it("update_space refuses users together with add_users / remove_users", async () => {
    await deploy("u1", { ...ok, visibility: "users", users: ["qa@example.com"] });
    const r = await update("u1", { name: "s1", users: ["x@example.com"], add_users: ["y@example.com"] });
    expect(r.error).toBe("CONFLICTING_USERS");
    expect(await getShares("s1")).toEqual(["qa@example.com"]);
  });

  it("update_space validates add_users / remove_users before changing anything", async () => {
    await deploy("u1", { ...ok, visibility: "users", users: ["qa@example.com"] });
    expect((await update("u1", { name: "s1", title: "x", add_users: ["not-an-email"] })).error).toBe("INVALID_USERS");
    // Removing the last person from a 'users' Space is refused, and the title is not applied either.
    expect((await update("u1", { name: "s1", title: "x", remove_users: ["qa@example.com"] })).error).toBe("USERS_REQUIRED");
    expect((await getSpace("s1"))!.title).toBe("Items");
    expect(await getShares("s1")).toEqual(["qa@example.com"]);
    // Switching to 'users' with add_users satisfies the requirement.
    await update("u1", { name: "s1", visibility: "org", users: [] });
    const r = await update("u1", { name: "s1", visibility: "users", add_users: ["dev@example.com"] });
    expect(r.applied).toMatchObject({ visibility: "users", users: ["dev@example.com"] });
  });

  it("update_space add_users returns FORBIDDEN when the owner changed between check and write", async () => {
    await deploy("u1", ok);
    const stale = (await getSpace("s1"))!;
    await db.run("UPDATE spaces SET owner_id = ? WHERE name = ?", ["u2", "s1"]);
    vi.mocked(getSpace).mockResolvedValueOnce(stale);
    expect((await update("u1", { name: "s1", add_users: ["x@example.com"] })).error).toBe("FORBIDDEN");
    expect(await getShares("s1")).toEqual([]);
  });

  it("update_space returns FORBIDDEN when the owner changed between check and write", async () => {
    await deploy("u1", ok);
    const stale = (await getSpace("s1"))!;
    await db.run("UPDATE spaces SET owner_id = ? WHERE name = ?", ["u2", "s1"]);
    vi.mocked(getSpace).mockResolvedValueOnce(stale);
    expect((await update("u1", { name: "s1", title: "Hijack" })).error).toBe("FORBIDDEN");
    expect((await getSpace("s1"))!.title).toBe("Items");
    vi.mocked(getSpace).mockResolvedValueOnce(stale);
    expect((await update("u1", { name: "s1", users: ["x@example.com"] })).error).toBe("FORBIDDEN");
    expect(await getShares("s1")).toEqual([]);
  });

  it("list_spaces: own by default, `all` for admins only", async () => {
    await deploy("u1", ok);
    await deploy("u2", { ...ok, name: "s2" });
    writeSpaceFiles(tmp, "s1", { "index.html": "x" });
    const own = await list("u1", {});
    expect(own.spaces).toHaveLength(1);
    expect(own.spaces[0]).toMatchObject({ name: "s1", title: "Items", visibility: "org", tools: ["acme_list_items"], users: [], url: `${config.PORTAL_URL}/s/s1`, live: true });
    expect(own.spaces[0].ownerEmail).toBeUndefined();
    expect((await list("u1", { all: true })).error).toBe("FORBIDDEN");
    const all = await list("admin", { all: true });
    expect(all.spaces.map((s: any) => [s.name, s.ownerEmail]).sort()).toEqual([
      ["s1", "dev@example.com"],
      ["s2", "qa@example.com"],
    ]);
  });

  it("list_space_files is owner only", async () => {
    await deploy("u1", ok);
    writeSpaceFiles(tmp, "s1", { "index.html": "x", "a/b.js": "y" });
    expect((await files("u1", { name: "s1" })).files.map((f: any) => f.path)).toEqual(["a/b.js", "index.html"]);
    expect((await files("u2", { name: "s1" })).error).toBe("FORBIDDEN");
    expect((await files("admin", { name: "s1" })).error).toBe("FORBIDDEN");
    expect((await files("u1", { name: "nope" })).error).toBe("NOT_FOUND");
  });

  it("delete_space: owner or admin, and it cascades", async () => {
    await deploy("u1", ok);
    await deploy("u1", { ...ok, name: "s2" });
    writeSpaceFiles(tmp, "s1", { "index.html": "x" });
    await grantConsent((await getSpace("s1"))!, "u2");
    await kvPut("s1", "u2", "k", "1");
    expect((await del("u2", { name: "s1" })).error).toBe("FORBIDDEN");
    expect(await del("u1", { name: "s1" })).toEqual({ ok: true, name: "s1" });
    expect(await getSpace("s1")).toBeNull();
    expect(fs.existsSync(path.join(tmp, "s1"))).toBe(false);
    expect(Number((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM space_kv"))!.n)).toBe(0);
    expect(await del("admin", { name: "s2" })).toEqual({ ok: true, name: "s2" });
    expect((await del("u1", { name: "s2" })).error).toBe("NOT_FOUND");
  });
});

describe("spaces plugin: delegated access", () => {
  const grantAndEnable = async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    const s = (await getSpace("s1"))!;
    const r = await updateSpaceMeta("s1", "u1", { accessMode: "owner", confirmDelegation: true, expectedToolsHash: toolsHash(s.tools) });
    if (!r || typeof r === "string") throw new Error("setup failed");
  };
  const offRows = () =>
    db.all<{ user_id: string; action: string; tool: string; error: string | null }>(
      "SELECT user_id, action, tool, error FROM audit_log WHERE action LIKE 'SPACE_DELEGATION_%' ORDER BY id"
    );

  it("both tools accept delegate_access in their schema", () => {
    for (const name of ["deploy_space", "update_space"]) {
      const schema = spacesPlugin.tools.find((t) => t.name === name)!.inputSchema;
      expect(schema.safeParse({ ...ok, delegate_access: false }).success).toBe(true);
      expect(schema.safeParse({ ...ok, delegate_access: "no" }).success).toBe(false);
    }
  });

  it("delegate_access true is DELEGATION_PORTAL_ONLY on both tools, and nothing changes", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    const refused = { error: "DELEGATION_PORTAL_ONLY", message: "Delegated access can only be turned on by you in the portal (Space > Sharing)." };
    expect(await deploy("u1", { ...ok, delegate_access: true })).toEqual(refused);
    expect(await getSpace("s1")).toBeNull();
    await deploy("u1", ok);
    expect(await update("u1", { name: "s1", title: "Changed", delegate_access: true })).toEqual(refused);
    expect(await deploy("u1", { ...ok, title: "Changed", delegate_access: true })).toEqual(refused);
    expect(await getSpace("s1")).toMatchObject({ title: "Items", accessMode: "viewer" });
    expect(await offRows()).toEqual([]);
  });

  it("update_space delegate_access false turns it off and audits; again is a no-op", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    const r = await update("u1", { name: "s1", delegate_access: false });
    expect(r.applied).toMatchObject({ delegate_access: false });
    expect(await getSpace("s1")).toMatchObject({ accessMode: "viewer", delegatedToolsHash: null });
    expect(await offRows()).toEqual([{ user_id: "u1", action: "SPACE_DELEGATION_OFF", tool: "space:s1", error: null }]);
    await update("u1", { name: "s1", delegate_access: false });
    expect(await offRows()).toHaveLength(1);
  });

  it("deploy_space delegate_access false turns it off and audits", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    await deploy("u1", { ...ok, delegate_access: false });
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect(await offRows()).toEqual([{ user_id: "u1", action: "SPACE_DELEGATION_OFF", tool: "space:s1", error: null }]);
  });

  it("a redeploy without the field keeps the mode; to private resets it with a reason", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    await deploy("u1", { ...ok, title: "Again" });
    expect(await getSpace("s1")).toMatchObject({ title: "Again", accessMode: "owner" });
    expect(await offRows()).toEqual([]);
    await deploy("u1", { ...ok, visibility: "private" });
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect((await offRows()).map((r) => [r.tool, r.error ?? null])).toEqual([["space:s1 (reason: audience set to only me)", null]]);
  });

  describe("widening the audience of a delegated Space is portal-only", () => {
    const WIDEN = {
      error: "DELEGATION_PORTAL_ONLY",
      message:
        "This Space runs with your delegated access. Widen who can open it in the portal (Space > Sharing), or turn delegated access off first.",
    };
    const usersSpace = { ...ok, visibility: "users", users: ["qa@example.com"] };
    const setup = async () => {
      await deploy("u1", usersSpace);
      await grantAndEnable();
    };
    const unchanged = async () => {
      expect(await getSpace("s1")).toMatchObject({ visibility: "users", accessMode: "owner" });
      expect(await getShares("s1")).toEqual(["qa@example.com"]);
    };

    it("update_space users -> org", async () => {
      await setup();
      expect(await update("u1", { name: "s1", visibility: "org" })).toEqual(WIDEN);
      await unchanged();
    });

    it("update_space add_users with someone new", async () => {
      await setup();
      expect(await update("u1", { name: "s1", add_users: ["ops@example.com"] })).toEqual(WIDEN);
      await unchanged();
    });

    it("update_space users replace that adds anyone, even while removing others", async () => {
      await setup();
      expect(await update("u1", { name: "s1", users: ["ops@example.com"] })).toEqual(WIDEN);
      await unchanged();
    });

    it("deploy_space to org, or with a users list holding someone new", async () => {
      await setup();
      expect(await deploy("u1", { ...ok, title: "Again" })).toEqual(WIDEN);
      expect(await deploy("u1", { ...usersSpace, users: ["qa@example.com", "ops@example.com"] })).toEqual(WIDEN);
      await unchanged();
    });

    it("narrowing stays allowed: removing people, org -> users, private, and the same list again", async () => {
      await deploy("u1", { ...usersSpace, users: ["qa@example.com", "ops@example.com"] });
      await grantAndEnable();
      expect((await update("u1", { name: "s1", remove_users: ["ops@example.com"] })).applied).toMatchObject({ delegate_access: true });
      expect((await update("u1", { name: "s1", add_users: ["qa@example.com"] })).applied).toMatchObject({ delegate_access: true });
      expect((await deploy("u1", { ...usersSpace, title: "Again" })).delegate_access).toBe(true);
      expect(await getShares("s1")).toEqual(["qa@example.com"]);
    });

    it("org -> users narrows and is allowed", async () => {
      await deploy("u1", ok);
      await grantAndEnable();
      const r = await update("u1", { name: "s1", visibility: "users", users: ["qa@example.com"] });
      expect(r.applied).toMatchObject({ visibility: "users", delegate_access: true });
    });

    it("turning it off in the same call allows the widening, and so does private", async () => {
      await setup();
      expect((await update("u1", { name: "s1", visibility: "org", delegate_access: false })).applied).toMatchObject({
        visibility: "org",
        delegate_access: false,
      });
      await grantAndEnable();
      expect((await update("u1", { name: "s1", visibility: "private" })).applied).toMatchObject({ visibility: "private" });
    });

    it("a Space not delegated widens freely", async () => {
      await deploy("u1", usersSpace);
      expect((await update("u1", { name: "s1", visibility: "org" })).applied).toMatchObject({ visibility: "org" });
    });
  });

  it("update_space to private resets with a reason", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    await update("u1", { name: "s1", visibility: "private" });
    expect((await getSpace("s1"))!.accessMode).toBe("viewer");
    expect((await offRows()).map((r) => [r.action, r.tool, r.error ?? null])).toEqual([
      ["SPACE_DELEGATION_OFF", "space:s1 (reason: audience set to only me)", null],
    ]);
  });

  it("update_space changing tools on a delegated Space is allowed and reports it paused", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    const r = await update("u1", { name: "s1", tools: ["acme_list_items", "acme_fail"] });
    expect(r.applied.tools).toEqual(["acme_fail", "acme_list_items"]);
    expect(r.delegation_suspended).toBe(true);
    expect(r.note).toBe("Delegated access is paused until you confirm the new tool list in the portal.");
    expect((await getSpace("s1"))!.accessMode).toBe("owner");
    // A change that leaves the confirmed list alone says nothing about it.
    const plain = await update("u1", { name: "s1", tools: ["acme_list_items"], title: "T2" });
    expect(plain.delegation_suspended).toBeUndefined();
    expect(plain.note).toBeUndefined();
  });

  it("a failed audit write does not fail update_space, and the mode is saved", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    vi.spyOn(auditLogger, "log").mockRejectedValue(new Error("audit store down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await update("u1", { name: "s1", delegate_access: false });
      expect(r.error).toBeUndefined();
      expect((await getSpace("s1"))!.accessMode).toBe("viewer");
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("delegation_active is the effective state; delegate_access stays the stored one", async () => {
    await deploy("u1", ok);
    await grantAndEnable();
    expect((await list("u1", {})).spaces[0]).toMatchObject({ delegate_access: true, delegation_active: true });
    expect((await update("u1", { name: "s1", title: "T2" })).applied).toMatchObject({ delegate_access: true, delegation_active: true });
    expect(await deploy("u1", { ...ok, title: "T3" })).toMatchObject({ delegate_access: true, delegation_active: true });
    await db.run("DELETE FROM user_permissions WHERE user_id = ?", ["u1"]);
    expect((await list("u1", {})).spaces[0]).toMatchObject({ delegate_access: true, delegation_active: false });
    expect((await list("admin", { all: true })).spaces[0]).toMatchObject({ delegate_access: true, delegation_active: false });
    expect((await update("u1", { name: "s1", title: "T4" })).applied).toMatchObject({ delegate_access: true, delegation_active: false });
    expect(await deploy("u1", { ...ok, title: "T5" })).toMatchObject({ delegate_access: true, delegation_active: false });
  });

  it("list_spaces shows delegate_access and delegation_suspended", async () => {
    await deploy("u1", ok);
    let s = (await list("u1", {})).spaces[0];
    expect(s).toMatchObject({ delegate_access: false, delegation_suspended: false });
    await grantAndEnable();
    s = (await list("u1", {})).spaces[0];
    expect(s).toMatchObject({ delegate_access: true, delegation_suspended: false });
    const redeployed = await deploy("u1", { ...ok, tools: ["acme_fail"] });
    expect(redeployed).toMatchObject({ delegation_suspended: true, note: expect.stringContaining("paused") });
    s = (await list("u1", {})).spaces[0];
    expect(s).toMatchObject({ delegate_access: true, delegation_suspended: true });
    const all = (await list("admin", { all: true })).spaces[0];
    expect(all).toMatchObject({ delegate_access: true, delegation_suspended: true });
  });

  it("HOW_TO_BUILD names both access modes and the new error codes", () => {
    const d = spacesPlugin.tools.find((t) => t.name === "deploy_space")!.description;
    expect(d).toContain("the viewer's connections, or the owner's when the owner turned on delegated access in the portal");
    expect(d).not.toMatch(/using THEIR connections/);
    expect(d).toContain("DELEGATION_OFF");
    expect(d).toContain("TOOL_NOT_DELEGABLE");
  });
});
