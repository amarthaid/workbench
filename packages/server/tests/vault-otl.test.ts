import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import {
  mintOtl,
  consumeOtl,
  revokeFor,
  reapExpiredOtl,
  otlUrl,
  _setNowForTest,
  OTL_SENTINEL,
  OTL_DEFAULT_TTL_SECONDS,
  OTL_MAX_TTL_SECONDS,
} from "../src/vault/otl";

beforeEach(async () => {
  _setNowForTest(() => Date.now());
  await db.run("DELETE FROM pending_auth");
  await db.run("DELETE FROM user_vaults");
  await putSecret("u1", "pw", "hunter2");
});
afterEach(() => _setNowForTest(() => Date.now()));

describe("vault one-time links", () => {
  it("mints a 32-hex token under the vault sentinel and never stores the value", async () => {
    const m = await mintOtl("u1", "pw");
    expect(m.token).toMatch(/^[0-9a-f]{32}$/);
    expect(m.url).toBe(otlUrl(m.token));
    expect(m.url).toContain("/api/vault/otl/");
    expect(m.expiresAt).toBeGreaterThan(Date.now() + (OTL_DEFAULT_TTL_SECONDS - 5) * 1000);
    const row = await db.get<{ integration: string; session_data: string; user_id: string }>(
      "SELECT integration, session_data, user_id FROM pending_auth WHERE state = ?",
      [m.token]
    );
    expect(row?.integration).toBe(OTL_SENTINEL);
    expect(row?.user_id).toBe("u1");
    expect(row?.session_data).not.toContain("hunter2");
  });

  it("refuses to mint for a secret that does not exist", async () => {
    await expect(mintOtl("u1", "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mintOtl("u2", "pw")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clamps ttl to the max", async () => {
    const m = await mintOtl("u1", "pw", OTL_MAX_TTL_SECONDS * 10);
    expect(m.expiresAt).toBeLessThanOrEqual(Date.now() + OTL_MAX_TTL_SECONDS * 1000 + 1000);
  });

  it("is consumed exactly once", async () => {
    const m = await mintOtl("u1", "pw");
    expect(await consumeOtl(m.token)).toEqual({ userId: "u1", name: "pw" });
    expect(await consumeOtl(m.token)).toBeNull();
  });

  it("gives exactly one winner to concurrent redeems", async () => {
    const m = await mintOtl("u1", "pw");
    const results = await Promise.all([consumeOtl(m.token), consumeOtl(m.token), consumeOtl(m.token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expires", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    const m = await mintOtl("u1", "pw", 60);
    _setNowForTest(() => t0 + 61_000);
    expect(await consumeOtl(m.token)).toBeNull();
  });

  it("rejects junk tokens", async () => {
    expect(await consumeOtl("")).toBeNull();
    expect(await consumeOtl("zz")).toBeNull();
  });

  it("revokeFor drops every link for one secret and nothing else", async () => {
    await putSecret("u1", "other", "x");
    const a = await mintOtl("u1", "pw");
    const b = await mintOtl("u1", "pw");
    const c = await mintOtl("u1", "other");
    await revokeFor("u1", "pw");
    expect(await consumeOtl(a.token)).toBeNull();
    expect(await consumeOtl(b.token)).toBeNull();
    expect(await consumeOtl(c.token)).not.toBeNull();
  });

  it("reap is scoped to the vault sentinel", async () => {
    const t0 = Date.now();
    _setNowForTest(() => t0);
    const m = await mintOtl("u1", "pw", 60);
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)",
      ["foreign", "u1", "__file_ul__", Math.floor(t0 / 1000) - 10]
    );
    _setNowForTest(() => t0 + 120_000);
    await reapExpiredOtl();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [m.token])).toBeFalsy();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", ["foreign"])).toBeTruthy();
  });
});
