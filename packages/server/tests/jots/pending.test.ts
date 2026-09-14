import { describe, it, expect, beforeEach, vi } from "vitest";

import { db } from "../../src/db";
import {
  mint,
  consume,
  reapExpired,
  _setNowForTest,
  startUploadReaper,
  stopUploadReaper,
} from "../../src/jots/pending";

const SENTINEL = "__jot_upload__";

async function countRows(integration = SENTINEL): Promise<number> {
  const row = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_auth WHERE integration = ?",
    [integration]
  );
  return Number(row?.n ?? 0);
}

describe("jots/pending", () => {
  let t = 1_000_000;
  beforeEach(async () => {
    t = 1_000_000;
    _setNowForTest(() => t);
    await db.exec("DELETE FROM pending_auth");
  });

  it("mints a token and consumes it once", async () => {
    const { token, expiresAt } = await mint({ owner: "u1", name: "site", access: "public" });
    expect(typeof token).toBe("string");
    expect(expiresAt).toBe(t + 300_000);
    const p = await consume(token);
    expect(p).toMatchObject({ owner: "u1", name: "site", access: "public" });
    expect(await consume(token)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await consume("nope")).toBeNull();
    expect(await consume("")).toBeNull();
  });

  it("does not return an expired token", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    t += 300_001;
    expect(await consume(token)).toBeNull();
  });

  it("reapExpired drops only expired rows", async () => {
    const a = await mint({ owner: "u1", name: "a", access: "public" });
    t += 100_000;
    const b = await mint({ owner: "u1", name: "b", access: "public" });
    t += 250_000;
    await reapExpired();
    expect(await countRows()).toBe(1);
    expect(await consume(a.token)).toBeNull();
    expect(await consume(b.token)).toMatchObject({ name: "b" });
  });

  it("carries the password hash for password jots", async () => {
    const { token } = await mint({ owner: "u1", name: "s", access: "password", passwordHash: "scrypt$x$y" });
    expect(await consume(token)).toMatchObject({ access: "password", passwordHash: "scrypt$x$y" });
  });

  it("the reaper starts idempotently and stops cleanly", () => {
    expect(() => {
      startUploadReaper(60_000);
      startUploadReaper(60_000); // second call is a no-op (timer already set)
      stopUploadReaper();
      stopUploadReaper(); // safe to call when no timer is running
    }).not.toThrow();
  });

  it("defaults mode to replace when unspecified", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    expect(await consume(token)).toMatchObject({ mode: "replace" });
  });

  it("mints a patch token carrying the delete list", async () => {
    const { token } = await mint({ owner: "u1", name: "site", mode: "patch", deletes: ["old.json", "stale/"] });
    expect(await consume(token)).toMatchObject({ mode: "patch", name: "site", deletes: ["old.json", "stale/"] });
  });

  it("carries the cors flag", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public", cors: true });
    expect(await consume(token)).toMatchObject({ cors: true });
  });

  it("stores an arbitrarily long delete list — the token is a handle, not the payload", async () => {
    const deletes = Array.from({ length: 400 }, (_, i) => `some/reasonably/long/path/segment/file-${i}.json`);
    const { token } = await mint({ owner: "u1", name: "site", mode: "patch", deletes });
    expect(token).toHaveLength(64);
    expect(await consume(token)).toMatchObject({ deletes });
  });

  // --- the properties the database buys us ---

  it("is durable: the row outlives the process that minted it", async () => {
    const { token } = await mint({ owner: "u1", name: "survivor", access: "public" });
    // A fresh module instance holds no memory of the mint, as after a restart
    // or on a second worker, and still consumes the token.
    vi.resetModules();
    const fresh = await import("../../src/jots/pending");
    fresh._setNowForTest(() => t);
    expect(await fresh.consume(token)).toMatchObject({ owner: "u1", name: "survivor" });
  });

  it("only one of two concurrent consumes wins", async () => {
    const { token } = await mint({ owner: "u1", name: "race", access: "public" });
    const results = await Promise.all([consume(token), consume(token), consume(token)]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await countRows()).toBe(0);
  });

  it("consuming leaves no row behind", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    expect(await countRows()).toBe(1);
    await consume(token);
    expect(await countRows()).toBe(0);
  });

  // --- sentinel scoping: this flow must not touch the OAuth/SSO rows ---

  it("cannot consume another flow's pending_auth row", async () => {
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
      ["sso-state", "u9", "__oauth_authorize__", Math.floor(t / 1000) + 600, JSON.stringify({ clientId: "c1" })]
    );
    expect(await consume("sso-state")).toBeNull();
    // and the row is untouched
    expect(await countRows("__oauth_authorize__")).toBe(1);
  });

  it("reapExpired leaves another flow's expired rows alone", async () => {
    await db.run(
      "INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)",
      ["stale-oauth", "u9", "jira", Math.floor(t / 1000) - 60]
    );
    await reapExpired();
    expect(await countRows("jira")).toBe(1);
  });

  it("stores the owner in user_id and the deploy in session_data", async () => {
    const { token } = await mint({ owner: "u-42", name: "site", access: "public", cors: true });
    const row = await db.get<{ user_id: string; integration: string; session_data: string }>(
      "SELECT user_id, integration, session_data FROM pending_auth WHERE state = ?",
      [token]
    );
    expect(row?.user_id).toBe("u-42");
    expect(row?.integration).toBe(SENTINEL);
    expect(JSON.parse(row!.session_data)).toMatchObject({ name: "site", mode: "replace", cors: true });
  });

  it("returns null when the stored payload is unreadable", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    await db.run("UPDATE pending_auth SET session_data = ? WHERE state = ?", ["not json", token]);
    expect(await consume(token)).toBeNull();
  });
});
