import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { can, setPermission, clearPermission, listPermissions } from "../src/permissions/store";
import { CAPABILITIES, type Capability } from "../src/permissions/capabilities";

describe("user_permissions table", () => {
  beforeEach(async () => {
    await db.exec("DELETE FROM user_permissions");
  });

  it("keeps one rule per (user, capability, subject)", async () => {
    const insert = (effect: string) =>
      db.run(
        "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["u1", "spaces.delegate_access", "", effect, "admin", 1]
      );
    await insert("allow");
    await expect(insert("deny")).rejects.toThrow();
  });
});

describe("can()", () => {
  beforeEach(async () => {
    await db.exec("DELETE FROM user_permissions");
  });

  it("falls back to the declared default", async () => {
    expect(CAPABILITIES["spaces.delegate_access"].default).toBe("deny");
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });

  it("an allow row grants; a deny row refuses", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect(await can("u1", "spaces.delegate_access")).toBe(true);
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "deny", grantedBy: "admin" });
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });

  it("clearing returns to the default", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    await clearPermission("u1", "spaces.delegate_access");
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
  });

  it("is scoped to the user", async () => {
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect(await can("u2", "spaces.delegate_access")).toBe(false);
  });

  it("rejects an undeclared capability on write and never grants it on read", async () => {
    await expect(
      setPermission({ userId: "u1", capability: "nope", effect: "allow", grantedBy: "a" })
    ).rejects.toThrow(/unknown capability/);
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u1','nope','','allow','a',1)"
    );
    // can() is typed to declared capabilities; the cast simulates a stray row
    // or a caller that bypassed the type, which must still read as denied.
    expect(await can("u1", "nope" as Capability)).toBe(false);
  });

  it("reads through: no cache between a write and the next check", async () => {
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u1','spaces.delegate_access','','allow','a',1)"
    );
    expect(await can("u1", "spaces.delegate_access")).toBe(true);
  });

  it("listPermissions shows each capability with default vs rule", async () => {
    expect((await listPermissions("u1"))[0]).toMatchObject({
      capability: "spaces.delegate_access",
      effect: "deny",
      source: "default",
      grantedBy: null,
      grantedAt: null,
    });
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    const [view] = await listPermissions("u1");
    expect(view).toMatchObject({ effect: "allow", source: "rule", grantedBy: "admin", default: "deny" });
    expect(typeof view.grantedAt).toBe("number");
  });

  it("clearPermission reports whether a rule was removed", async () => {
    expect(await clearPermission("u1", "spaces.delegate_access")).toBe(false);
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "admin" });
    expect(await clearPermission("u1", "spaces.delegate_access")).toBe(true);
    expect(await clearPermission("u1", "spaces.delegate_access")).toBe(false);
  });

  it("listPermissions normalises an unexpected stored effect to deny, like can()", async () => {
    await db.run(
      "INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at) VALUES ('u1','spaces.delegate_access','','ALLOW','a',1)"
    );
    expect(await can("u1", "spaces.delegate_access")).toBe(false);
    expect((await listPermissions("u1"))[0]).toMatchObject({ effect: "deny", source: "rule" });
  });

  it("listPermissions returns the granting user's email, or null when unknown", async () => {
    await db.exec("DELETE FROM users");
    await db.run("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", ["user-admin", "admin@example.com", 1]);
    await setPermission({ userId: "u1", capability: "spaces.delegate_access", effect: "allow", grantedBy: "user-admin" });
    expect((await listPermissions("u1"))[0]).toMatchObject({ grantedBy: "user-admin", grantedByEmail: "admin@example.com" });

    await setPermission({ userId: "u2", capability: "spaces.delegate_access", effect: "allow", grantedBy: "user-gone" });
    expect((await listPermissions("u2"))[0]).toMatchObject({ grantedBy: "user-gone", grantedByEmail: null });

    expect((await listPermissions("u3"))[0]).toMatchObject({ grantedBy: null, grantedByEmail: null });
  });
});
