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
  return { ...actual, getSpace: vi.fn(actual.getSpace) };
});

import { config } from "../../src/config";
import { db } from "../../src/db";
import { consume } from "../../src/spaces/pending";
import { getShares, getSpace, grantConsent, kvPut } from "../../src/spaces/store";
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
    expect(own.spaces[0]).toMatchObject({ name: "s1", title: "Items", visibility: "org", tools: ["acme_list_items"], url: `${config.PORTAL_URL}/s/s1`, live: true });
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
