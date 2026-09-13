import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/config", () => ({
  config: { JOTS_UPLOAD_TTL_SECONDS: 300, SESSION_SECRET: "test-session-secret-32-chars-long!!" },
}));

import {
  mint,
  consume,
  reapExpired,
  _setNowForTest,
  startUploadReaper,
  stopUploadReaper,
  MAX_TOKEN_CHARS,
  UploadTokenTooLargeError,
} from "../../src/jots/pending";
import { config } from "../../src/config";

const SECRET = "test-session-secret-32-chars-long!!";

describe("jots/pending", () => {
  let t = 1_000_000;
  beforeEach(() => {
    t = 1_000_000;
    _setNowForTest(() => t);
    reapExpired();
  });
  afterEach(() => {
    config.SESSION_SECRET = SECRET;
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
  });

  it("does not return an expired token", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    t += 300_001;
    expect(await consume(token)).toBeNull();
  });

  it("reapExpired drops only replayable entries that have expired anyway", async () => {
    const a = await mint({ owner: "u1", name: "a", access: "public" });
    t += 100_000;
    const b = await mint({ owner: "u1", name: "b", access: "public" });
    t += 250_000;
    reapExpired();
    // `a` is past its own exp, so it is refused on its merits, not by the guard.
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

  // --- stateless-token properties ---

  it("is a compact JWE, so the payload is opaque to whoever holds the URL", async () => {
    const { token } = await mint({
      owner: "user-42",
      name: "site",
      access: "password",
      passwordHash: "scrypt$deadbeef$cafe",
    });
    // header..iv.ciphertext.tag — `dir` leaves the encrypted-key part empty.
    expect(token.split(".")).toHaveLength(5);
    // Neither the owner nor the password hash is readable from the token.
    expect(token).not.toContain("user-42");
    expect(token).not.toContain("cafe");
    expect(Buffer.from(token.split(".")[3], "base64url").toString("utf8")).not.toContain("scrypt");
  });

  it("is URL-path safe", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    expect(token).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it("survives a process restart — a fresh module consumes a token it never minted", async () => {
    _setNowForTest(() => Date.now());
    const { token } = await mint({ owner: "u1", name: "survivor", access: "public" });

    vi.resetModules();
    const fresh = await import("../../src/jots/pending");
    expect(await fresh.consume(token)).toMatchObject({ owner: "u1", name: "survivor" });
  });

  it("rejects a token minted under a different SESSION_SECRET", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    config.SESSION_SECRET = "a-completely-different-secret-32c!!";
    expect(await consume(token)).toBeNull();
  });

  it("rejects a tampered ciphertext", async () => {
    const { token } = await mint({ owner: "u1", name: "site", access: "public" });
    const parts = token.split(".");
    const ct = Buffer.from(parts[3], "base64url");
    ct[0] ^= 0xff;
    parts[3] = ct.toString("base64url");
    expect(await consume(parts.join("."))).toBeNull();
  });

  it("rejects a token whose claims were re-signed with no encryption", async () => {
    // A bare JWS-style token — the shape an attacker would forge if the token
    // were merely signed — is not a JWE and must not decrypt.
    const forged = Buffer.from(JSON.stringify({ owner: "attacker", name: "site", mode: "replace" })).toString("base64url");
    expect(await consume(`eyJhbGciOiJub25lIn0.${forged}.`)).toBeNull();
  });

  it("refuses to mint a token too long for a URL", async () => {
    const deletes = Array.from({ length: 500 }, (_, i) => `some/reasonably/long/path/segment/file-${i}.json`);
    await expect(mint({ owner: "u1", name: "site", mode: "patch", deletes })).rejects.toBeInstanceOf(
      UploadTokenTooLargeError
    );
  });

  it("mints a delete list that fits", async () => {
    const deletes = Array.from({ length: 20 }, (_, i) => `data/file-${i}.json`);
    const { token } = await mint({ owner: "u1", name: "site", mode: "patch", deletes });
    expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_CHARS);
    expect(await consume(token)).toMatchObject({ deletes });
  });

  it("refuses an over-long token without attempting to decrypt it", async () => {
    expect(await consume("x".repeat(MAX_TOKEN_CHARS + 1))).toBeNull();
  });
});
