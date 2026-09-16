import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import {
  putSecret,
  deleteSecret,
  listSecrets,
  readSecretValue,
  touchUsed,
  isValidVaultName,
  VaultError,
  VAULT_MAX_VALUE_BYTES,
} from "../src/vault/store";

beforeEach(async () => {
  await db.run("DELETE FROM user_vaults");
});

describe("vault store", () => {
  it("round-trips a value through encryption", async () => {
    await putSecret("u1", "site_pw", "hunter2", "login for example.com");
    const row = await db.get<{ value_enc: Buffer }>(
      "SELECT value_enc FROM user_vaults WHERE user_id = ? AND name = ?",
      ["u1", "site_pw"]
    );
    expect(Buffer.from(row!.value_enc).toString("utf8")).not.toContain("hunter2");
    expect(await readSecretValue("u1", "site_pw")).toBe("hunter2");
  });

  it("scopes reads to the owner", async () => {
    await putSecret("u1", "site_pw", "hunter2");
    expect(await readSecretValue("u2", "site_pw")).toBeNull();
    expect(await listSecrets("u2")).toEqual([]);
  });

  it("list never includes the value", async () => {
    await putSecret("u1", "site_pw", "hunter2", "d");
    const [e] = await listSecrets("u1");
    expect(Object.keys(e).sort()).toEqual(
      ["created_at", "description", "last_used_at", "name", "updated_at"].sort()
    );
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });

  it("overwrite reports created=false, keeps created_at, bumps updated_at", async () => {
    const first = await putSecret("u1", "k", "a");
    expect(first.created).toBe(true);
    await db.run("UPDATE user_vaults SET created_at = 100, updated_at = 100 WHERE name = ?", ["k"]);
    const second = await putSecret("u1", "k", "b", "new desc");
    expect(second.created).toBe(false);
    const [e] = await listSecrets("u1");
    expect(e.created_at).toBe(100);
    expect(e.updated_at).toBeGreaterThan(100);
    expect(e.description).toBe("new desc");
    expect(await readSecretValue("u1", "k")).toBe("b");
  });

  it("validates names", async () => {
    expect(isValidVaultName("a")).toBe(true);
    expect(isValidVaultName("site_pw.v2-x")).toBe(true);
    expect(isValidVaultName("Site")).toBe(false);
    expect(isValidVaultName("_x")).toBe(false);
    expect(isValidVaultName("a b")).toBe(false);
    expect(isValidVaultName("a".repeat(65))).toBe(false);
    expect(isValidVaultName("")).toBe(false);
    expect(isValidVaultName(42)).toBe(false);
    await expect(putSecret("u1", "Bad", "x")).rejects.toMatchObject({ code: "INVALID_NAME" });
    expect(await readSecretValue("u1", "Bad")).toBeNull();
  });

  it("rejects empty and oversize values", async () => {
    await expect(putSecret("u1", "k", "")).rejects.toMatchObject({ code: "EMPTY_VALUE" });
    await expect(putSecret("u1", "k", "x".repeat(VAULT_MAX_VALUE_BYTES + 1))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    // multibyte counts bytes, not chars
    await expect(putSecret("u1", "k", "é".repeat(VAULT_MAX_VALUE_BYTES))).rejects.toMatchObject({
      code: "TOO_LARGE",
    });
    expect(await putSecret("u1", "k", "x".repeat(VAULT_MAX_VALUE_BYTES))).toEqual({ created: true });
  });

  it("delete returns whether a row went", async () => {
    await putSecret("u1", "k", "a");
    expect(await deleteSecret("u1", "k")).toBe(true);
    expect(await deleteSecret("u1", "k")).toBe(false);
    expect(await readSecretValue("u1", "k")).toBeNull();
  });

  it("touchUsed stamps last_used_at only for the given names", async () => {
    await putSecret("u1", "a", "1");
    await putSecret("u1", "b", "2");
    await touchUsed("u1", ["a", "nope"]);
    const rows = await listSecrets("u1");
    expect(rows.find((r) => r.name === "a")!.last_used_at).not.toBeNull();
    expect(rows.find((r) => r.name === "b")!.last_used_at).toBeNull();
    await touchUsed("u1", []); // no-op, no throw
  });

  it("VaultError carries its code as message", () => {
    const e = new VaultError("TOO_LARGE");
    expect(e.message).toBe("TOO_LARGE");
  });
});
