import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activeProfiles } from "../src/auth/profile-chromium";
import {
  trimProfileCaches,
  profileLastUsed,
  listProfileDirs,
  reapProfileDisk,
} from "../src/auth/profile-disk";

function makeProfile(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, "Default", "Cache"), { recursive: true });
  mkdirSync(join(dir, "Default", "Code Cache", "js"), { recursive: true });
  mkdirSync(join(dir, "Default", "Local Storage", "leveldb"), { recursive: true });
  mkdirSync(join(dir, "Safe Browsing"), { recursive: true });
  writeFileSync(join(dir, "Default", "Cache", "data_1"), "x".repeat(4096));
  writeFileSync(join(dir, "Default", "Code Cache", "js", "index"), "x".repeat(2048));
  writeFileSync(join(dir, "Safe Browsing", "UrlSoceng.store"), "x".repeat(8192));
  writeFileSync(join(dir, "Default", "Cookies"), "session-state");
  writeFileSync(join(dir, "Default", "Local Storage", "leveldb", "000003.log"), "state");
  return dir;
}

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "profiles-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  activeProfiles.clear();
});

describe("trimProfileCaches", () => {
  it("deletes regenerable caches and keeps session state", async () => {
    const dir = makeProfile(base, "user-a");

    const freed = await trimProfileCaches(dir);

    expect(freed).toBe(4096 + 2048 + 8192);
    expect(existsSync(join(dir, "Default", "Cache"))).toBe(false);
    expect(existsSync(join(dir, "Default", "Code Cache"))).toBe(false);
    expect(existsSync(join(dir, "Safe Browsing"))).toBe(false);
    // the whole point of a persistent profile — untouched
    expect(existsSync(join(dir, "Default", "Cookies"))).toBe(true);
    expect(existsSync(join(dir, "Default", "Local Storage", "leveldb", "000003.log"))).toBe(true);
  });

  it("is a no-op on an already-trimmed profile", async () => {
    const dir = makeProfile(base, "user-a");
    await trimProfileCaches(dir);
    expect(await trimProfileCaches(dir)).toBe(0);
  });
});

describe("profileLastUsed", () => {
  it("reads the marker file, not the directory mtime", async () => {
    const dir = makeProfile(base, "user-a");
    const old = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(join(dir, "Default", "Cookies"), old, old);

    // trimming mutates the directory mtime; staleness must not reset because of it
    await trimProfileCaches(dir);

    expect(await profileLastUsed(dir)).toBeCloseTo(old.getTime(), -3);
  });
});

describe("reapProfileDisk", () => {
  it("deletes profiles unused past the TTL and trims the rest", async () => {
    const idle = makeProfile(base, "idle");
    const stale = makeProfile(base, "stale");
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(join(stale, "Default", "Cookies"), old, old);
    // Idle but well inside the TTL: eligible for a trim, not for deletion.
    // It has to be older than LIVE_WINDOW_MS, since a profile whose use-marker
    // moved in the last hour is assumed to have a live chromium holding it.
    const yesterday = new Date(Date.now() - 86_400_000);
    utimesSync(join(idle, "Default", "Cookies"), yesterday, yesterday);

    const r = await reapProfileDisk({ baseDir: base });

    expect(existsSync(stale)).toBe(false);
    expect(r.deleted).toEqual([stale]);
    expect(existsSync(idle)).toBe(true);
    expect(existsSync(join(idle, "Default", "Cache"))).toBe(false);
    expect(existsSync(join(idle, "Default", "Cookies"))).toBe(true);
  });

  it("skips a profile whose use-marker moved inside the live window", async () => {
    // The out-of-process substitute for activeProfiles: a running chromium
    // rewrites Cookies/Preferences continuously, so a recent marker means a
    // live session whose caches must not be pulled out from under it.
    const busy = makeProfile(base, "busy");

    const r = await reapProfileDisk({ baseDir: base });

    expect(r.skippedActive).toBe(1);
    expect(existsSync(join(busy, "Default", "Cache"))).toBe(true);
  });

  it("never touches a profile with a live session", async () => {
    const dir = makeProfile(base, "busy");
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(join(dir, "Default", "Cookies"), old, old);
    activeProfiles.add("busy");

    const r = await reapProfileDisk({ baseDir: base });

    expect(r.skippedActive).toBe(1);
    expect(r.deleted).toEqual([]);
    expect(existsSync(join(dir, "Default", "Cache"))).toBe(true);
  });

  it("returns an empty list when the base dir does not exist", async () => {
    expect(await listProfileDirs(join(base, "nope"))).toEqual([]);
  });
});
