import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "../src/db";
import { putSecret } from "../src/vault/store";
import { verifyAuthState } from "../src/auth/oauth";
import {
  mintOtl,
  mintAdhocOtl,
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

  it("will not consume a row belonging to another sentinel", async () => {
    // pending_auth is the shared short-TTL handshake table. consumeOtl must
    // match on OTL_SENTINEL as well as the token, or a well-formed 32-hex
    // state minted by the jot-upload or oauth-authorize flow would be spent
    // here — and, for __oauth_authorize__, its session_data even carries a
    // `name`, so only the sentinel check stops it.
    const future = Math.floor(Date.now() / 1000) + 600;
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)",
      [a, "u1", "__file_ul__", future]
    );
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
      [b, "u1", "__oauth_authorize__", future, JSON.stringify({ name: "pw" })]
    );
    expect(await consumeOtl(a)).toBeNull();
    expect(await consumeOtl(b)).toBeNull();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [a])).toBeTruthy();
    expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [b])).toBeTruthy();
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

  describe("ad hoc (never stored) links", () => {
    it("mints under the vault sentinel with the value encrypted in the row, no vault row", async () => {
      const m = await mintAdhocOtl("u1", "one-shot-pw");
      expect(m.token).toMatch(/^[0-9a-f]{32}$/);
      expect(m.url).toBe(otlUrl(m.token));
      const row = await db.get<{ integration: string; session_data: string; user_id: string }>(
        "SELECT integration, session_data, user_id FROM pending_auth WHERE state = ?",
        [m.token]
      );
      expect(row?.integration).toBe(OTL_SENTINEL);
      expect(row?.user_id).toBe("u1");
      expect(row?.session_data).not.toContain("one-shot-pw");
      expect(JSON.parse(row!.session_data)).toEqual({ adhoc: expect.any(String) });
      const vaultRows = await db.all("SELECT name FROM user_vaults WHERE user_id = ?", ["u1"]);
      expect(vaultRows).toEqual([{ name: "pw" }]);
    });

    it("redeems the value exactly once and the row is gone", async () => {
      const m = await mintAdhocOtl("u1", "one-shot-pw");
      expect(await consumeOtl(m.token)).toEqual({ userId: "u1", value: "one-shot-pw" });
      expect(await consumeOtl(m.token)).toBeNull();
      expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [m.token])).toBeFalsy();
    });

    it("gives exactly one winner to concurrent redeems", async () => {
      const m = await mintAdhocOtl("u1", "one-shot-pw");
      const results = await Promise.all([consumeOtl(m.token), consumeOtl(m.token), consumeOtl(m.token)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("expires and is reaped", async () => {
      const t0 = Date.now();
      _setNowForTest(() => t0);
      const m = await mintAdhocOtl("u1", "one-shot-pw", 60);
      _setNowForTest(() => t0 + 61_000);
      expect(await consumeOtl(m.token)).toBeNull();
      // The reaper's `expires_at < now` is in whole seconds; give it a full one.
      _setNowForTest(() => t0 + 62_000);
      await reapExpiredOtl();
      expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [m.token])).toBeFalsy();
    });

    it("enforces the vault's value rules and clamps ttl", async () => {
      await expect(mintAdhocOtl("u1", "")).rejects.toMatchObject({ code: "EMPTY_VALUE" });
      await expect(mintAdhocOtl("u1", "x".repeat(8193))).rejects.toMatchObject({ code: "TOO_LARGE" });
      const m = await mintAdhocOtl("u1", "x".repeat(8192), OTL_MAX_TTL_SECONDS * 10);
      expect(m.expiresAt).toBeLessThanOrEqual(Date.now() + OTL_MAX_TTL_SECONDS * 1000 + 1000);
    });

    it("revokeFor a stored secret does not touch ad hoc links", async () => {
      const a = await mintAdhocOtl("u1", "one-shot-pw");
      await revokeFor("u1", "pw");
      expect(await consumeOtl(a.token)).not.toBeNull();
    });

    it("refuses a non-string adhoc field and a value that no longer decrypts, as 404 not 500", async () => {
      const future = Math.floor(Date.now() / 1000) + 600;
      const bad = "d".repeat(32);
      await db.run(
        "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
        [bad, "u1", OTL_SENTINEL, future, JSON.stringify({ adhoc: 42 })]
      );
      expect(await consumeOtl(bad)).toBeNull();
      expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [bad])).toBeTruthy();

      const rotten = "e".repeat(32);
      await db.run(
        "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
        [rotten, "u1", OTL_SENTINEL, future, JSON.stringify({ adhoc: Buffer.alloc(48, 7).toString("base64") })]
      );
      expect(await consumeOtl(rotten)).toBeNull();
      // Spent all the same: the token is single-use whether or not it paid out.
      expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [rotten])).toBeFalsy();
    });

    it("cannot be spent through the OAuth callback's state check", async () => {
      // verifyAuthState consumes pending_auth by state alone for every real
      // integration; an ad hoc token has the same shape and must not be
      // destroyed (or read) that way.
      const m = await mintAdhocOtl("u1", "one-shot-pw");
      expect(await verifyAuthState(m.token)).toBeNull();
      expect(await consumeOtl(m.token)).toEqual({ userId: "u1", value: "one-shot-pw" });
    });

    it("refuses a row that claims to be both kinds", async () => {
      const future = Math.floor(Date.now() / 1000) + 600;
      const t = "c".repeat(32);
      await db.run(
        "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
        [t, "u1", OTL_SENTINEL, future, JSON.stringify({ name: "pw", adhoc: "AAAA" })]
      );
      expect(await consumeOtl(t)).toBeNull();
      expect(await db.get("SELECT 1 FROM pending_auth WHERE state = ?", [t])).toBeTruthy();
    });
  });
});
