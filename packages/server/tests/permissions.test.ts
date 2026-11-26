import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";

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
