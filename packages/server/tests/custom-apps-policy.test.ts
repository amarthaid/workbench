import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ listCustomApps: vi.fn(async () => []) }));
vi.mock("../src/custom-apps/store", async (orig) => ({
  ...(await orig<typeof import("../src/custom-apps/store")>()),
  listCustomApps: store.listCustomApps,
}));
// Passes through; a test counts the permission reads of one listing.
vi.mock("../src/permissions/store", async (orig) => {
  const actual = await orig<typeof import("../src/permissions/store")>();
  return { ...actual, can: vi.fn(actual.can) };
});

import { ensureIndex, invalidateIndex } from "../src/custom-apps/index";
import { metaTools } from "../src/mcp/meta-tools";
import { db } from "../src/db";
import { CAPABILITIES } from "../src/permissions/capabilities";
import { can, clearPermission, setPermission } from "../src/permissions/store";

const grant = (userId: string) =>
  setPermission({ userId, capability: "custom_apps.create", effect: "allow", grantedBy: "u-admin" });

beforeEach(async () => {
  store.listCustomApps.mockClear();
  vi.mocked(can).mockClear();
  await db.exec("DELETE FROM user_permissions");
  invalidateIndex("u1");
  invalidateIndex("u2");
});

describe("the custom_apps.create capability", () => {
  it("is declared, default deny", () => {
    expect(CAPABILITIES["custom_apps.create"]).toEqual({
      default: "deny",
      label: "Add and use custom apps",
      description: "Lets this user connect their own MCP servers as custom apps.",
    });
  });

  it("is denied by default and granted by an allow row", async () => {
    expect(await can("u1", "custom_apps.create")).toBe(false);
    await grant("u1");
    expect(await can("u1", "custom_apps.create")).toBe(true);
    await clearPermission("u1", "custom_apps.create");
    expect(await can("u1", "custom_apps.create")).toBe(false);
  });
});

describe("ensureIndex and the custom_apps.create capability", () => {
  it("returns no tools, and never reads the user's apps, by default", async () => {
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("looks up the user's apps when the user is allowed, and only that user's", async () => {
    await grant("u1");
    await ensureIndex("u1");
    expect(store.listCustomApps).toHaveBeenCalledWith("u1");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u2")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("applies a revoke even when the user's index is cached", async () => {
    await grant("u1");
    await ensureIndex("u1"); // caches an (empty) index
    await clearPermission("u1", "custom_apps.create");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("a tool listing takes exactly one permission read", async () => {
    await grant("u1");
    const search = metaTools.find((t) => t.name === "search_tools")!;
    vi.mocked(can).mockClear();
    await (search.handler as (ctx: { userId: string }, args: { query: string }) => Promise<unknown>)({ userId: "u1" }, { query: "anything" });
    expect(vi.mocked(can)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(can)).toHaveBeenCalledWith("u1", "custom_apps.create");
  });
});
