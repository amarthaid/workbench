import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import { spawnProfileChromium } from "../src/auth/profile-chromium";

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
    expect(options.env).toBe(env);
  });

  it("defaults env to process.env", async () => {
    await expect(spawnProfileChromium("spawn-opts-user")).rejects.toThrow(/exited/);
    expect(spawnMock.mock.calls[0][2].env).toBe(process.env);
  });
});
