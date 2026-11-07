import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db";
import { mint, consume, reapExpired, _setNowForTest, SPACE_UPLOAD_SENTINEL } from "../../src/spaces/pending";
import { mint as mintJot } from "../../src/jots/pending";

describe("spaces/pending", () => {
  let t = 1_000_000;
  beforeEach(async () => {
    t = 1_000_000;
    _setNowForTest(() => t);
    await db.exec("DELETE FROM pending_auth");
  });

  it("uses its own sentinel and is single use", async () => {
    expect(SPACE_UPLOAD_SENTINEL).toBe("__space_upload__");
    const { token, expiresAt } = await mint({ owner: "u1", name: "s1" });
    expect(expiresAt).toBe(t + 300_000);
    const row = await db.get<{ integration: string }>("SELECT integration FROM pending_auth WHERE state = ?", [token]);
    expect(row?.integration).toBe("__space_upload__");
    expect(await consume(token)).toMatchObject({ owner: "u1", name: "s1", mode: "replace" });
    expect(await consume(token)).toBeNull();
  });

  it("carries patch deletes", async () => {
    const { token } = await mint({ owner: "u1", name: "s1", mode: "patch", deletes: ["old.js"] });
    expect(await consume(token)).toMatchObject({ mode: "patch", deletes: ["old.js"] });
  });

  it("two concurrent consumes: exactly one wins", async () => {
    const { token } = await mint({ owner: "u1", name: "s1" });
    const [a, b] = await Promise.all([consume(token), consume(token)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("expires, and is never confused with a jot token", async () => {
    const { token } = await mint({ owner: "u1", name: "s1" });
    t += 300_001;
    expect(await consume(token)).toBeNull();
    const jot = await mintJot({ owner: "u1", name: "j1", access: "public" });
    expect(await consume(jot.token)).toBeNull();
  });

  it("the reaper drops only expired space rows", async () => {
    await mint({ owner: "u1", name: "old" });
    t += 400_000;
    const fresh = await mint({ owner: "u1", name: "new" });
    await db.run("INSERT INTO pending_auth (state, user_id, integration, expires_at) VALUES (?, ?, ?, ?)", ["other", "u1", "__jot_upload__", 1]);
    await reapExpired();
    const rows = await db.all<{ state: string }>("SELECT state FROM pending_auth ORDER BY state");
    expect(rows.map((r) => r.state).sort()).toEqual(["other", fresh.token].sort());
  });
});
