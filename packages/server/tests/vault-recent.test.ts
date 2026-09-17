import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  rememberSubstituted,
  recentSubstituted,
  reapExpiredRecent,
  _setNowForTest,
  _resetForTest,
  _sizeForTest,
  VAULT_RECENT_WINDOW_MS,
  VAULT_RECENT_MAX_PER_USER,
} from "../src/vault/recent";

beforeEach(() => _resetForTest());
afterEach(() => _resetForTest());

describe("vault recent-values ring", () => {
  it("remembers a substituted value and reads it back", () => {
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    expect(recentSubstituted("u1")).toEqual(new Map([["pw", "hunter2"]]));
  });

  it("returns an empty map when nothing was ever remembered", () => {
    expect(recentSubstituted("nobody")).toEqual(new Map());
  });

  it("isolates rings per user", () => {
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    rememberSubstituted("u2", new Map([["pw", "different"]]));
    expect(recentSubstituted("u1")).toEqual(new Map([["pw", "hunter2"]]));
    expect(recentSubstituted("u2")).toEqual(new Map([["pw", "different"]]));
  });

  it("expires entries after the window", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    t += VAULT_RECENT_WINDOW_MS - 1;
    expect(recentSubstituted("u1")).toEqual(new Map([["pw", "hunter2"]]));
    t += 2;
    expect(recentSubstituted("u1")).toEqual(new Map());
  });

  it("dedupes by name, keeping the newest value", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    rememberSubstituted("u1", new Map([["pw", "old"]]));
    t += 1000;
    rememberSubstituted("u1", new Map([["pw", "new"]]));
    expect(recentSubstituted("u1")).toEqual(new Map([["pw", "new"]]));
  });

  it("caps at the newest N entries", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    for (let i = 0; i < VAULT_RECENT_MAX_PER_USER + 5; i++) {
      rememberSubstituted("u1", new Map([[`name${i}`, `value${i}`]]));
      t += 1;
    }
    const recent = recentSubstituted("u1");
    expect(recent.size).toBe(VAULT_RECENT_MAX_PER_USER);
    // The oldest 5 should have been evicted.
    expect(recent.has("name0")).toBe(false);
    expect(recent.has("name4")).toBe(false);
    expect(recent.has("name5")).toBe(true);
    expect(recent.has(`name${VAULT_RECENT_MAX_PER_USER + 4}`)).toBe(true);
  });

  it("provides a reset seam for test isolation", () => {
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    _resetForTest();
    expect(recentSubstituted("u1")).toEqual(new Map());
  });

  it("never holds a user who has nothing remembered", () => {
    expect(_sizeForTest()).toBe(0);
    recentSubstituted("nobody"); // read-only, never present to begin with
    expect(_sizeForTest()).toBe(0);
  });

  it("a reap sweep after the window elapses leaves the ring empty", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    rememberSubstituted("u2", new Map([["pw", "different"]]));
    expect(_sizeForTest()).toBe(2);

    t += VAULT_RECENT_WINDOW_MS + 1;
    reapExpiredRecent();
    expect(_sizeForTest()).toBe(0);
  });

  it("a reap sweep only drops the expired user, keeping a live one", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    rememberSubstituted("u1", new Map([["pw", "hunter2"]]));
    t += VAULT_RECENT_WINDOW_MS + 1;
    rememberSubstituted("u2", new Map([["pw", "different"]]));

    reapExpiredRecent();
    expect(_sizeForTest()).toBe(1);
    expect(recentSubstituted("u1")).toEqual(new Map());
    expect(recentSubstituted("u2")).toEqual(new Map([["pw", "different"]]));
  });

  it("prunes expired users inline once the ring holds more than 256 users, without waiting for the reaper", () => {
    let t = 1_000_000;
    _setNowForTest(() => t);
    for (let i = 0; i < 256; i++) {
      rememberSubstituted(`expired-${i}`, new Map([["pw", "x"]]));
    }
    t += VAULT_RECENT_WINDOW_MS + 1;
    // The 257th remember pushes the user count over the inline-prune
    // threshold; the 256 now-expired users should be swept as a side effect,
    // leaving only this one.
    rememberSubstituted("fresh", new Map([["pw", "y"]]));
    expect(_sizeForTest()).toBe(1);
    expect(recentSubstituted("fresh")).toEqual(new Map([["pw", "y"]]));
  });
});
