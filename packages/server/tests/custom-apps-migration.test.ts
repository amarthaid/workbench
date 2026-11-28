import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../src/db";
import { can } from "../src/permissions/store";
import { migrateCustomAppsPolicy } from "../src/permissions/custom-apps-migration";

const MARKER = "custom_apps_policy_migrated";

async function setPolicy(value: unknown) {
  await db.run("INSERT INTO instance_settings (key, value) VALUES ('custom_apps_policy', ?)", [JSON.stringify(value)]);
}
const allowed = async () =>
  (
    await db.all<{ user_id: string }>(
      "SELECT user_id FROM user_permissions WHERE capability = 'custom_apps.create' AND effect = 'allow' ORDER BY user_id"
    )
  ).map((r) => r.user_id);

beforeEach(async () => {
  for (const t of ["user_permissions", "instance_settings", "users", "audit_log", "custom_apps"]) {
    await db.exec(`DELETE FROM ${t}`);
  }
  for (const id of ["u1", "u2", "u3"]) await db.run("INSERT INTO users (id, email) VALUES (?, ?)", [id, `${id}@example.com`]);
});

describe("custom apps policy migration", () => {
  it("mode all grants every existing user", async () => {
    await setPolicy({ mode: "all", user_ids: [] });
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual(["u1", "u2", "u3"]);
    expect(await can("u2", "custom_apps.create")).toBe(true);
  });

  it("an instance that never set a policy keeps the old default (everyone)", async () => {
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual(["u1", "u2", "u3"]);
  });

  it("an unreadable stored policy is read as the old default (everyone)", async () => {
    await db.run("INSERT INTO instance_settings (key, value) VALUES ('custom_apps_policy', '{not json')");
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual(["u1", "u2", "u3"]);
  });

  it("mode allowlist grants only listed users that still exist", async () => {
    await setPolicy({ mode: "allowlist", user_ids: ["u1", "u3", "ghost"] });
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual(["u1", "u3"]);
  });

  it("mode none grants nobody but still sets the marker", async () => {
    await setPolicy({ mode: "none", user_ids: [] });
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual([]);
    expect(await db.get("SELECT 1 AS n FROM instance_settings WHERE key = ?", [MARKER])).toBeTruthy();
  });

  it("rows are plain allow rows with a system grantor and no audit row per user", async () => {
    await setPolicy({ mode: "all", user_ids: [] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await migrateCustomAppsPolicy();
    const row = await db.get<{ subject: string; effect: string; granted_by: string }>(
      "SELECT subject, effect, granted_by FROM user_permissions WHERE user_id = 'u1'"
    );
    expect(row).toEqual({ subject: "", effect: "allow", granted_by: "system" });
    expect(await db.all("SELECT 1 FROM audit_log")).toHaveLength(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("3");
    log.mockRestore();
  });

  it("the marker prevents a second run, and a repeat changes nothing", async () => {
    await setPolicy({ mode: "allowlist", user_ids: ["u1"] });
    await migrateCustomAppsPolicy();
    await db.run("DELETE FROM user_permissions WHERE user_id = 'u1'");
    await db.run("UPDATE instance_settings SET value = ? WHERE key = 'custom_apps_policy'", [JSON.stringify({ mode: "all", user_ids: [] })]);
    expect(await migrateCustomAppsPolicy()).toBe(0);
    expect(await allowed()).toEqual([]);
  });

  it("does not overwrite an existing explicit row", async () => {
    await setPolicy({ mode: "all", user_ids: [] });
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u2', 'custom_apps.create', '', 'deny', 'admin1', 5)"
    );
    await migrateCustomAppsPolicy();
    expect(await allowed()).toEqual(["u1", "u3"]);
  });

  it("users created afterwards are denied", async () => {
    await setPolicy({ mode: "all", user_ids: [] });
    await migrateCustomAppsPolicy();
    await db.run("INSERT INTO users (id, email) VALUES ('late', 'late@example.com')");
    await migrateCustomAppsPolicy();
    expect(await can("late", "custom_apps.create")).toBe(false);
  });

  it("leaves existing custom apps untouched", async () => {
    await setPolicy({ mode: "none", user_ids: [] });
    await db.run(
      "INSERT INTO custom_apps (id, user_id, name, base_url, metadata) VALUES ('a1', 'u1', 'acme', 'https://mcp.example.com/mcp', '{}')"
    );
    await migrateCustomAppsPolicy();
    expect((await db.all("SELECT id FROM custom_apps")).length).toBe(1);
  });

  it("two concurrent runs insert each row once and only one reports the work", async () => {
    await setPolicy({ mode: "all", user_ids: [] });
    const results = await Promise.all([migrateCustomAppsPolicy(), migrateCustomAppsPolicy(), migrateCustomAppsPolicy()]);
    expect(results.filter((n) => n > 0)).toEqual([3]);
    expect(await allowed()).toEqual(["u1", "u2", "u3"]);
    const n = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM user_permissions");
    expect(Number(n?.n)).toBe(3);
  });
});
