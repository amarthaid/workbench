import { describe, it, expect, beforeEach } from "vitest";
import { db, initDb } from "../src/db";
import { isUserDisabled, setUserDisabled } from "../src/auth/user-status";

beforeEach(async () => {
  await db.exec("DELETE FROM users");
  await db.exec("DELETE FROM instance_settings");
});

describe("isUserDisabled / setUserDisabled", () => {
  it("is false for an active user, true once disabled, false again once enabled", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
    expect(await isUserDisabled("u1")).toBe(false);
    expect(await setUserDisabled("u1", true)).toBe(true);
    expect(await isUserDisabled("u1")).toBe(true);
    expect(await setUserDisabled("u1", false)).toBe(true);
    expect(await isUserDisabled("u1")).toBe(false);
  });

  it("reports whether the state changed, so repeating an action is a no-op", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["u1", "dev@example.com"]);
    expect(await setUserDisabled("u1", false)).toBe(false); // already enabled
    expect(await setUserDisabled("u1", true, 1000)).toBe(true);
    expect(await setUserDisabled("u1", true, 2000)).toBe(false); // already disabled
    const row = await db.get<{ disabled_at: number }>("SELECT disabled_at FROM users WHERE id = ?", ["u1"]);
    expect(Number(row?.disabled_at)).toBe(1000); // the first timestamp is kept
  });

  it("does not treat a user with no row as disabled", async () => {
    expect(await isUserDisabled("never-seen")).toBe(false);
    expect(await setUserDisabled("never-seen", true)).toBe(false);
  });
});

describe("schema", () => {
  it("is idempotent: running initDb again changes nothing and does not throw", async () => {
    await initDb();
    await initDb();
    await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["u2", "off@example.com", 5]);
    expect(await isUserDisabled("u2")).toBe(true);
  });

  it("has an instance_settings table that accepts and returns a row", async () => {
    await db.run(
      "INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
      ["disabled_integrations", "[]", 1, "u1"]
    );
    const row = await db.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", [
      "disabled_integrations",
    ]);
    expect(row?.value).toBe("[]");
  });
});
