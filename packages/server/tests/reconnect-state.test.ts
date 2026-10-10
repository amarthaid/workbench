import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../src/db";
import { storeCookies, hasValidCookies } from "../src/auth/cookie";
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

  it("tolerates a non-JSON config", async () => {
    await storeCookies(U, I, cookies);
    await db.run("UPDATE connections SET config = 'not json' WHERE user_id = ?", [U]);
    expect(await getReconnectState(U, I)).toEqual({});
  });
});
