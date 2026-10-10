import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnProfileChromium, userProfileDir } from "../src/auth/profile-chromium";

// A chromium that dies at once: spawnProfileChromium rejects fast, and the
// only thing under test is what it handed to spawn().
function deadProc() {
  const proc = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: vi.fn() });
  setImmediate(() => proc.emit("exit", 1, null));
  return proc;
}

describe("spawnProfileChromium spawn options", () => {
  beforeEach(() => spawnMock.mockReset().mockImplementation(deadProc));

  it("appends extraArgs and passes env through to spawn", async () => {
    const env = { PULSE_SERVER: "unix:/x/native" };
    await expect(
      spawnProfileChromium("spawn-opts-user", { env, extraArgs: ["--autoplay-policy=no-user-gesture-required"] })
    ).rejects.toThrow(/exited/);
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args).toContain("--autoplay-policy=no-user-gesture-required");
    expect(args).toContain("--use-mock-keychain");
    expect(args).toContain("--password-store=basic");
    // DevTools sockets only from an origin no page can have (src/auth/cdp-origin.ts).
    expect(args).toContain("--remote-allow-origins=http://workbench-cdp.invalid");
    expect(args.join(" ")).not.toContain("remote-allow-origins=http://127.0.0.1");
    expect(options.env).toBe(env);
  });

  it("turns the password manager off in the profile before spawn, keeping other prefs", async () => {
    // A recipe fills a vault password into the page; chromium must not offer
    // to save it, or save it, into the profile's Login Data.
    const dir = join(userProfileDir("spawn-pm-user"), "Default");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Preferences"), JSON.stringify({ profile: { name: "Test User", password_manager_enabled: true }, other: 1 }));
    await expect(spawnProfileChromium("spawn-pm-user")).rejects.toThrow(/exited/);
    const prefs = JSON.parse(readFileSync(join(dir, "Preferences"), "utf8"));
    expect(prefs.credentials_enable_service).toBe(false);
    expect(prefs.profile.password_manager_enabled).toBe(false);
    expect(prefs.profile.name).toBe("Test User");
    expect(prefs.other).toBe(1);
  });

  it("writes the password-manager prefs into a fresh profile too", async () => {
    const dir = join(userProfileDir("spawn-pm-fresh"), "Default");
    rmSync(userProfileDir("spawn-pm-fresh"), { recursive: true, force: true });
    await expect(spawnProfileChromium("spawn-pm-fresh")).rejects.toThrow(/exited/);
    const prefs = JSON.parse(readFileSync(join(dir, "Preferences"), "utf8"));
    expect(prefs).toEqual({ credentials_enable_service: false, profile: { password_manager_enabled: false } });
  });

  it("defaults env to process.env", async () => {
    await expect(spawnProfileChromium("spawn-opts-user")).rejects.toThrow(/exited/);
    expect(spawnMock.mock.calls[0][2].env).toBe(process.env);
  });
});
