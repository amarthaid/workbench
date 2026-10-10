import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "../src/db";
import { storeCookies, hasValidCookies, clearReconnectFailure } from "../src/auth/cookie";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { getConnectionConfig } from "../src/auth/tokens";

const U = "user-reconnect-state";
const I = "acme-cookie";
const cookies = {
  domain: "app.example.com",
  cookies: [{ name: "sid", value: "tok-abc", domain: "app.example.com", path: "/", expires: 9999999999 }],
  capturedAt: 1,
};

describe("reconnect state", () => {
  beforeEach(async () => {
    await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  });

  it("is empty when there is no connection row", async () => {
    expect(await getReconnectState(U, I)).toEqual({});
  });

  it("merges patches and preserves other config keys", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = ? WHERE user_id = ? AND integration = ?", [JSON.stringify({ instanceUrl: "x" }), U, I]);
    await updateReconnectState(U, I, { bindings: { password: "acme_pw" } });
    await updateReconnectState(U, I, { deadAt: 123 });
    expect(await getReconnectState(U, I)).toEqual({ bindings: { password: "acme_pw" }, deadAt: 123 });
    expect(JSON.parse((await getConnectionConfig(U, I))!).instanceUrl).toBe("x");
  });

  it("removes keys patched to undefined", async () => {
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { deadAt: 1 });
    await updateReconnectState(U, I, { deadAt: undefined });
    expect(await getReconnectState(U, I)).toEqual({});
  });

  it("hasValidCookies is false while deadAt is set", async () => {
    await storeCookies(U, I, cookies);
    expect(await hasValidCookies(U, I)).toBe(true);
    await updateReconnectState(U, I, { deadAt: Date.now() });
    expect(await hasValidCookies(U, I)).toBe(false);
  });

  it("storeCookies clears deadAt but keeps bindings", async () => {
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { deadAt: 1, bindings: { password: "acme_pw" } });
    await storeCookies(U, I, cookies);
    expect(await getReconnectState(U, I)).toEqual({ bindings: { password: "acme_pw" } });
  });

  it("storeCookies clears deadAt but never a recorded failure: the cooldown survives any cookie write", async () => {
    // Import accepts an API key. If storing cookies reset the cooldown, an
    // agent could loop import -> dead call -> failed recipe without a cap.
    await storeCookies(U, I, cookies);
    const failed = { at: 5, ok: false, error: "verify: NO_COOKIES" };
    await updateReconnectState(U, I, { deadAt: 5, last: failed });
    await storeCookies(U, I, cookies);
    expect(await getReconnectState(U, I)).toEqual({ last: failed });
  });

  it("clearReconnectFailure drops a failed attempt, keeps a success, and stamps clearedAt", async () => {
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { last: { at: 5, ok: false, error: "verify: NO_COOKIES" } });
    await clearReconnectFailure(U, I);
    expect(await getReconnectState(U, I)).toEqual({ clearedAt: expect.any(Number) });
    await updateReconnectState(U, I, { last: { at: 6, ok: true } });
    await clearReconnectFailure(U, I);
    expect(await getReconnectState(U, I)).toEqual({ last: { at: 6, ok: true }, clearedAt: expect.any(Number) });
  });

  it("tolerates a non-JSON config", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = 'not json' WHERE user_id = ?", [U]);
    expect(await getReconnectState(U, I)).toEqual({});
  });

  it("never rewrites a config that failed to parse: it survives storeCookies and updates", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = 'not json' WHERE user_id = ?", [U]);
    await storeCookies(U, I, cookies);
    await updateReconnectState(U, I, { deadAt: 1 });
    expect(await getConnectionConfig(U, I)).toBe("not json");
  });

  it("storeCookies issues no config UPDATE when there is no reconnect state", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = ? WHERE user_id = ?", [JSON.stringify({ instanceUrl: "x" }), U]);
    const run = vi.spyOn(db, "run");
    try {
      await storeCookies(U, I, cookies);
      const configWrites = run.mock.calls.filter(([sql]) => /UPDATE connections SET config/.test(String(sql)));
      expect(configWrites).toHaveLength(0);
    } finally {
      run.mockRestore();
    }
    expect(JSON.parse((await getConnectionConfig(U, I))!)).toEqual({ instanceUrl: "x" });
  });
});
