import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({ listCustomApps: vi.fn(async () => []) }));
vi.mock("../src/custom-apps/store", async (orig) => ({
  ...(await orig<typeof import("../src/custom-apps/store")>()),
  listCustomApps: store.listCustomApps,
}));

import { ensureIndex, invalidateIndex } from "../src/custom-apps/index";
import { db } from "../src/db";
import { resetSettingsForTest, saveSetting } from "../src/settings/instance-settings";

beforeEach(async () => {
  store.listCustomApps.mockClear();
  await db.exec("DELETE FROM instance_settings");
  resetSettingsForTest();
  invalidateIndex("u1");
  invalidateIndex("u2");
});

describe("ensureIndex and the custom-app policy", () => {
  it("looks up the user's apps when custom apps are open to everyone", async () => {
    await ensureIndex("u1");
    expect(store.listCustomApps).toHaveBeenCalledWith("u1");
  });

  it("returns no tools, and never reads the user's apps, when the policy is none", async () => {
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("an allowlist admits only the listed users", async () => {
    await saveSetting("custom_apps_policy", { mode: "allowlist", user_ids: ["u1"] }, "u-admin");
    await ensureIndex("u1");
    expect(store.listCustomApps).toHaveBeenCalledWith("u1");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u2")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });

  it("applies a policy change even when the user's index is cached", async () => {
    await ensureIndex("u1"); // caches an (empty) index
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    store.listCustomApps.mockClear();
    expect(await ensureIndex("u1")).toEqual([]);
    expect(store.listCustomApps).not.toHaveBeenCalled();
  });
});
