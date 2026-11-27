import { describe, it, expect, beforeEach } from "vitest";
import { db, initDb } from "../src/db";
import { getUserStatus, isUserDisabled, setUserDisabled, setUserStatus } from "../src/auth/user-status";
import { createUser, verifyApiKey } from "../src/auth/users";
import { signSession, verifySession } from "../src/auth/session";

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

describe("users.status", () => {
  async function row(id: string) {
    return db.get<{ status: string; disabled_at: number | string | null }>(
      "SELECT status, disabled_at FROM users WHERE id = ?",
      [id]
    );
  }

  it("new rows default to active", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["s1", "dev@example.com"]);
    expect((await row("s1"))?.status).toBe("active");
    expect(await getUserStatus("s1")).toBe("active");
    expect(await getUserStatus("never-seen")).toBe("missing");
  });

  it("the boot backfill turns a row with disabled_at into disabled, and leaves pending alone", async () => {
    await db.run("INSERT INTO users (id, email, disabled_at) VALUES (?, ?, ?)", ["old", "old@example.com", 5]);
    await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', ?)", ["pend", "p@example.com", 6]);
    await initDb();
    expect((await row("old"))?.status).toBe("disabled");
    expect((await row("pend"))?.status).toBe("pending");
  });

  it("a row with disabled_at set and status active is blocked everywhere (old worker's disable)", async () => {
    const { apiKey } = await createUser("old-worker");
    const token = await signSession({ userId: "old-worker", email: "dev@example.com" });
    await db.run("UPDATE users SET disabled_at = 9 WHERE id = ?", ["old-worker"]);
    expect((await row("old-worker"))?.status).toBe("active");
    expect(await isUserDisabled("old-worker")).toBe(true);
    expect(await getUserStatus("old-worker")).toBe("disabled");
    expect(await verifyApiKey(apiKey)).toBeNull();
    await expect(verifySession(token)).rejects.toThrow("User disabled");
  });

  it("an old worker's enable (clears disabled_at only) does not release a pending or disabled user", async () => {
    await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'pending', ?)", ["p", "p@example.com", 6]);
    await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'disabled', ?)", ["d", "d@example.com", 6]);
    await db.run("UPDATE users SET disabled_at = NULL");
    expect(await isUserDisabled("p")).toBe(true);
    expect(await isUserDisabled("d")).toBe(true);
  });

  it("pending and disabled write disabled_at too (dual write); active clears it", async () => {
    await db.run("INSERT INTO users (id, email) VALUES (?, ?)", ["dw", "dw@example.com"]);
    expect(await setUserStatus("dw", "pending", { nowSeconds: 100 })).toBe(true);
    expect(await row("dw")).toMatchObject({ status: "pending" });
    expect(Number((await row("dw"))?.disabled_at)).toBe(100);
    // Disabling a pending user keeps the first timestamp.
    expect(await setUserStatus("dw", "disabled", { nowSeconds: 200 })).toBe(true);
    expect(Number((await row("dw"))?.disabled_at)).toBe(100);
    expect(await setUserStatus("dw", "active")).toBe(true);
    expect(await row("dw")).toMatchObject({ status: "active", disabled_at: null });
    expect(await setUserStatus("dw", "active")).toBe(false);
  });

  it("the from-guard: approve only fires on a still-pending user", async () => {
    await db.run("INSERT INTO users (id, email, status, disabled_at) VALUES (?, ?, 'disabled', ?)", ["g", "g@example.com", 6]);
    expect(await setUserStatus("g", "active", { from: "pending" })).toBe(false);
    expect((await row("g"))?.status).toBe("disabled");
    await db.run("UPDATE users SET status = 'pending' WHERE id = ?", ["g"]);
    expect(await setUserStatus("g", "active", { from: "pending" })).toBe(true);
    expect(await row("g")).toMatchObject({ status: "active", disabled_at: null });
  });
});
