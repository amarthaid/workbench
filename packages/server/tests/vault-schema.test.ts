import { describe, it, expect } from "vitest";
import { db } from "../src/db";

describe("user_vaults schema", () => {
  it("exists with a unique (user_id, name)", async () => {
    await db.run("DELETE FROM user_vaults");
    await db.run(
      "INSERT INTO user_vaults (id, user_id, name, value_enc) VALUES (?, ?, ?, ?)",
      ["a", "u1", "pw", Buffer.from("x")]
    );
    await expect(
      db.run("INSERT INTO user_vaults (id, user_id, name, value_enc) VALUES (?, ?, ?, ?)", [
        "b",
        "u1",
        "pw",
        Buffer.from("y"),
      ])
    ).rejects.toThrow();
    const row = await db.get<{ created_at: number; last_used_at: number | null }>(
      "SELECT created_at, last_used_at FROM user_vaults WHERE id = ?",
      ["a"]
    );
    expect(typeof row?.created_at).toBe("number");
    expect(row?.last_used_at).toBeNull();
  });
});
