import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "../src/db";
import { config } from "../src/config";
import {
  customAppsAllowedFor,
  getSettings,
  isIntegrationDisabled,
  loadSettings,
  resetSettingsForTest,
  saveSetting,
  startSettingsPoll,
  stopSettingsPoll,
} from "../src/settings/instance-settings";

beforeEach(async () => {
  await db.exec("DELETE FROM instance_settings");
  resetSettingsForTest();
});

afterEach(() => {
  stopSettingsPoll();
  vi.useRealTimers();
});

describe("instance settings", () => {
  it("defaults to nothing disabled and custom apps open to everyone", async () => {
    await loadSettings();
    expect(getSettings()).toEqual({
      disabled_integrations: [],
      custom_apps_policy: { mode: "all", user_ids: [] },
    });
    expect(isIntegrationDisabled("acme")).toBe(false);
    expect(customAppsAllowedFor("u1")).toBe(true);
  });

  it("saves a setting and makes it visible immediately in this process", async () => {
    await saveSetting("disabled_integrations", ["acme"], "u-admin");
    expect(isIntegrationDisabled("acme")).toBe(true);
    expect(isIntegrationDisabled("demo-repo")).toBe(false);
  });

  it("upserts: saving the same key twice keeps one row and the latest actor", async () => {
    await saveSetting("disabled_integrations", ["acme"], "u-one");
    await saveSetting("disabled_integrations", ["acme", "demo-repo"], "u-two");
    const rows = await db.all<{ key: string; value: string; updated_by: string }>(
      "SELECT key, value, updated_by FROM instance_settings"
    );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toEqual(["acme", "demo-repo"]);
    expect(rows[0].updated_by).toBe("u-two");
  });

  it("applies each custom-app policy mode", async () => {
    await saveSetting("custom_apps_policy", { mode: "none", user_ids: [] }, "u-admin");
    expect(customAppsAllowedFor("u1")).toBe(false);
    await saveSetting("custom_apps_policy", { mode: "allowlist", user_ids: ["u1"] }, "u-admin");
    expect(customAppsAllowedFor("u1")).toBe(true);
    expect(customAppsAllowedFor("u2")).toBe(false);
    await saveSetting("custom_apps_policy", { mode: "all", user_ids: [] }, "u-admin");
    expect(customAppsAllowedFor("u2")).toBe(true);
  });

  it("a corrupt stored value falls back to the default instead of throwing or disabling anything", async () => {
    for (const [key, value] of [
      ["disabled_integrations", "not json"],
      ["custom_apps_policy", "{also not json"],
    ]) {
      await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [key, value]);
    }
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual([]);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("a wrongly shaped stored value falls back to the default", async () => {
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", ["disabled_integrations", '{"a":1}']);
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "custom_apps_policy",
      JSON.stringify({ mode: "everyone", user_ids: "u1" }),
    ]);
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual([]);
    expect(getSettings().custom_apps_policy).toEqual({ mode: "all", user_ids: [] });
  });

  it("drops non-string entries from a stored list", async () => {
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "disabled_integrations",
      JSON.stringify(["acme", 7, null, "demo-repo"]),
    ]);
    await loadSettings();
    expect(getSettings().disabled_integrations).toEqual(["acme", "demo-repo"]);
  });
});

describe("settings poll", () => {
  it("picks up a change written by another process after the poll interval", async () => {
    vi.useFakeTimers();
    startSettingsPoll();
    // Another worker writes straight to the table.
    await db.run("INSERT INTO instance_settings (key, value) VALUES (?, ?)", [
      "disabled_integrations",
      JSON.stringify(["acme"]),
    ]);
    expect(isIntegrationDisabled("acme")).toBe(false); // not yet
    await vi.advanceTimersByTimeAsync(config.INSTANCE_SETTINGS_POLL_SECONDS * 1000 + 50);
    expect(isIntegrationDisabled("acme")).toBe(true);
  });

  it("keeps the last good snapshot when a reload fails", async () => {
    vi.useFakeTimers();
    await saveSetting("disabled_integrations", ["acme"], "u-admin");
    startSettingsPoll();
    const spy = vi.spyOn(db, "all").mockRejectedValueOnce(new Error("db down"));
    await vi.advanceTimersByTimeAsync(config.INSTANCE_SETTINGS_POLL_SECONDS * 1000 + 50);
    expect(isIntegrationDisabled("acme")).toBe(true);
    spy.mockRestore();
  });
});
