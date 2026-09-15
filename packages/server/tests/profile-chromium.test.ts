import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  userProfileDir,
  profilesBaseDir,
  activeProfiles,
  clearStaleSingletonLocks,
} from "../src/auth/profile-chromium";

describe("profile-chromium dirs", () => {
  it("derives a per-user dir under the base", () => {
    const dir = userProfileDir("user-abc");
    expect(dir.startsWith(profilesBaseDir())).toBe(true);
    expect(dir.endsWith("user-abc")).toBe(true);
  });
  it("sanitizes path-traversal characters in the userId", () => {
    const dir = userProfileDir("../../etc/passwd");
    expect(dir).not.toContain("..");
    expect(dir.startsWith(profilesBaseDir())).toBe(true);
  });
  it("exports a shared activeProfiles lock set", () => {
    expect(activeProfiles instanceof Set).toBe(true);
  });
});

describe("clearStaleSingletonLocks", () => {
  it("removes a stale SingletonLock symlink left by a dead pod", () => {
    const dir = mkdtempSync(join(tmpdir(), "prof-"));
    try {
      // chromium writes the lock as a symlink encoding <hostname>-<pid>; the
      // target need not exist (and here points at a dead host).
      symlinkSync("dead-pod-k8f84-424", join(dir, "SingletonLock"));
      writeFileSync(join(dir, "SingletonCookie"), "x");
      writeFileSync(join(dir, "SingletonSocket"), "x");

      clearStaleSingletonLocks(dir);

      expect(existsSync(join(dir, "SingletonLock"))).toBe(false);
      expect(existsSync(join(dir, "SingletonCookie"))).toBe(false);
      expect(existsSync(join(dir, "SingletonSocket"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op on a clean profile dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "prof-"));
    try {
      mkdirSync(join(dir, "Default"), { recursive: true });
      expect(() => clearStaleSingletonLocks(dir)).not.toThrow();
      // real profile data is untouched
      expect(existsSync(join(dir, "Default"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch budget", () => {
  it("defaults BROWSER_LAUNCH_TIMEOUT_MS to 15 seconds", async () => {
    const { config } = await import("../src/config");
    expect(config.BROWSER_LAUNCH_TIMEOUT_MS).toBe(15_000);
  });

  it("pollJson keeps polling until the deadline, not a fixed attempt count", async () => {
    // A cold chromium in a container took 5.3s to bring DevTools up; the old
    // budget was 40 attempts × 100ms ≈ 4s, so the first call of a fresh
    // container failed with "Failed to reach .../json/version" while chromium
    // was still starting, and the second call worked. Budget in time, not
    // attempts, and let the operator raise it.
    const { pollJson } = await import("../src/auth/profile-chromium");
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls < 8) throw new Error("ECONNREFUSED");
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    };
    const out = await pollJson("http://127.0.0.1:1/json/version", {
      deadlineMs: 2_000,
      intervalMs: 10,
      fetchImpl,
    });
    expect(out).toEqual({ ok: true });
    expect(calls).toBe(8);
  });

  it("pollJson gives up at the deadline with the last error", async () => {
    const { pollJson } = await import("../src/auth/profile-chromium");
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    await expect(
      pollJson("http://127.0.0.1:1/json/version", { deadlineMs: 50, intervalMs: 10, fetchImpl })
    ).rejects.toThrow(/Failed to reach .*ECONNREFUSED/);
  });
});
