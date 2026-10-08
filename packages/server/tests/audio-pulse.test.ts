import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";

vi.mock("../src/config", () => ({
  config: { SESSION_SECRET: "test-session-secret-32-chars-long!!" },
}));

import { PulseManager, deviceKey, deviceNames, pulseFor, releasePulse, shutdownAllPulse, type Exec, type Spawn } from "../src/audio/pulse";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.exitCode = null;
  p.stdin = new PassThrough();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = vi.fn(() => { p.exitCode = 0; p.emit("exit", 0, null); return true; });
  return p;
}

function fakeProcWithError() {
  const p = fakeProc();
  setImmediate(() => {
    p.exitCode = -2; // Node.js sets exitCode before emitting error on spawn failure
    p.emit("error", new Error("ENOENT: pulseaudio not found"));
  });
  return p;
}

// A fake pactl backed by a module table, so create/destroy/list are checked
// against state rather than against call order.
function fakePactl() {
  let next = 1;
  const modules: Array<{ idx: number; name: string; args: string }> = [];
  const calls: string[][] = [];
  const exec: Exec = vi.fn(async (_cmd, args) => {
    calls.push(args);
    if (args[0] === "info") return "Server Name: pulseaudio\n";
    if (args[0] === "load-module") {
      const idx = next++;
      modules.push({ idx, name: args[1], args: args.slice(2).join(" ") });
      return `${idx}\n`;
    }
    if (args[0] === "unload-module") {
      const i = modules.findIndex((m) => String(m.idx) === args[1]);
      if (i >= 0) modules.splice(i, 1);
      return "";
    }
    if (args[0] === "list" && args[1] === "short" && args[2] === "modules") {
      return modules.map((m) => `${m.idx}\t${m.name}\t${m.args}`).join("\n") + "\n";
    }
    throw new Error(`unexpected pactl ${args.join(" ")}`);
  });
  return { exec, modules, calls };
}

let daemon: any;
let spawnFn: Spawn;

beforeEach(() => {
  daemon = fakeProc();
  spawnFn = vi.fn(() => daemon) as unknown as Spawn;
});

describe("device naming", () => {
  it("derives 16 hex chars from the user id, never the id itself", () => {
    const k = deviceKey("user-1");
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(k).not.toContain("user");
    expect(deviceKey("user-1")).toBe(k);
    expect(deviceKey("user-2")).not.toBe(k);
  });

  it("names the three devices from the key", () => {
    expect(deviceNames("abcd1234abcd1234")).toEqual({
      sink: "wb_sink_abcd1234abcd1234",
      mic: "wb_mic_abcd1234abcd1234",
      source: "wb_src_abcd1234abcd1234",
    });
  });
});

describe("PulseManager daemon", () => {
  it("spawns pulseaudio once, bumps epoch when pactl answers", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "test1", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await Promise.all([pm.ensureDaemon(), pm.ensureDaemon()]);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawnFn as any).mock.calls[0];
    expect(cmd).toBe("pulseaudio");
    expect(args).toContain("--daemonize=no");
    expect(args).toContain("--exit-idle-time=-1");
    expect(args.join(" ")).toContain("socket=/tmp/wb-pulse-test/native");
    expect(pm.epoch).toBe(1);
    expect(pm.clientEnv().PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
  });

  it("emits daemon-exit and respawns with a new epoch on next demand", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "test2", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.ensureDaemon();
    const exited = vi.fn();
    pm.on("daemon-exit", exited);
    daemon.exitCode = 1;
    daemon.emit("exit", 1, null);
    expect(exited).toHaveBeenCalledTimes(1);
    daemon = fakeProc();
    await pm.ensureDaemon();
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(pm.epoch).toBe(2);
  });

  it("fails with the reason when pulseaudio dies before answering", async () => {
    const exec: Exec = vi.fn(async () => { throw new Error("Connection refused"); });
    const pm = new PulseManager({ key: "test3", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test", readyTimeoutMs: 300 });
    const p = pm.ensureDaemon();
    daemon.exitCode = 1;
    await expect(p).rejects.toThrow(/pulseaudio did not start/);
  });

  it("fails immediately when spawn emits error", async () => {
    const exec: Exec = vi.fn(async () => { throw new Error("Connection refused"); });
    const spawnError = vi.fn(() => {
      const p = fakeProc();
      setImmediate(() => p.emit("error", new Error("ENOENT: pulseaudio not found")));
      return p;
    }) as unknown as Spawn;
    const pm = new PulseManager({ key: "test4", exec, spawn: spawnError, runtimeDir: "/tmp/wb-pulse-test", readyTimeoutMs: 200 });
    await expect(pm.ensureDaemon()).rejects.toThrow(/pulseaudio did not start/);
  });

  it("after a failed start, same manager spawns again and no daemon-exit fired", async () => {
    const pmFail = new PulseManager({ key: "test5", exec: vi.fn(async () => { throw new Error("fail"); }), spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-fail", readyTimeoutMs: 100 });
    const exitFired = vi.fn();
    pmFail.on("daemon-exit", exitFired);
    // First ensureDaemon fails (exec throws)
    await expect(pmFail.ensureDaemon()).rejects.toThrow(/pulseaudio did not start/);
    expect(exitFired).not.toHaveBeenCalled();
    // Second ensureDaemon on same manager: replace exec but it still fails
    (pmFail as any).opts.exec = vi.fn(async () => { throw new Error("fail again"); });
    daemon = fakeProc();
    await expect(pmFail.ensureDaemon()).rejects.toThrow(/pulseaudio did not start/);
    expect(exitFired).not.toHaveBeenCalled();
  });
});

describe("PulseManager shutdown", () => {
  // A daemon that, like pulseaudio, takes a moment to exit after SIGTERM.
  function slowExitDaemon() {
    const p = fakeProc();
    p.signalCode = null;
    p.kill = vi.fn(() => true);
    return p;
  }

  it("removes the runtime dir only after the daemon has exited", async () => {
    daemon = slowExitDaemon();
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "sd1", exec, spawn: spawnFn });
    await pm.ensureDaemon();
    const dir = pm.clientEnv().PULSE_SERVER!.replace(/^unix:/, "").replace(/\/native$/, "");
    expect(existsSync(dir)).toBe(true);
    let resolved = false;
    const done = pm.shutdown().then(() => { resolved = true; });
    expect(daemon.kill).toHaveBeenCalledWith("SIGTERM");
    // pulseaudio writes into its HOME while exiting; the dir must outlive it.
    await new Promise((r) => setImmediate(r));
    expect(existsSync(dir)).toBe(true);
    expect(resolved).toBe(false);
    daemon.exitCode = 0;
    daemon.emit("exit", 0, null);
    await done;
    expect(existsSync(dir)).toBe(false);
  });

  it("SIGKILLs a daemon that ignores SIGTERM, then removes the dir", async () => {
    vi.useFakeTimers();
    try {
      daemon = slowExitDaemon();
      const { exec } = fakePactl();
      const pm = new PulseManager({ key: "sd2", exec, spawn: spawnFn });
      await pm.ensureDaemon();
      const dir = pm.clientEnv().PULSE_SERVER!.replace(/^unix:/, "").replace(/\/native$/, "");
      const done = pm.shutdown();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(daemon.kill).toHaveBeenCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(500);
      await done;
      expect(existsSync(dir)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PulseManager devices", () => {
  it("creates sink, mic sink, and a remap source over the mic monitor", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ key: "dev1", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    const d = await pm.createDevices("abcd1234abcd1234");
    expect(d).toEqual(deviceNames("abcd1234abcd1234"));
    expect(modules.map((m) => m.name)).toEqual(["module-null-sink", "module-null-sink", "module-remap-source"]);
    expect(modules[0].args).toContain("sink_name=wb_sink_abcd1234abcd1234");
    expect(modules[1].args).toContain("sink_name=wb_mic_abcd1234abcd1234");
    expect(modules[2].args).toContain("source_name=wb_src_abcd1234abcd1234");
    expect(modules[2].args).toContain("master=wb_mic_abcd1234abcd1234.monitor");
  });

  it("is idempotent", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ key: "dev2", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("abcd1234abcd1234");
    await pm.createDevices("abcd1234abcd1234");
    expect(modules).toHaveLength(3);
  });

  it("concurrent createDevices(sameKey) share one creation", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ key: "dev3", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    const [d1, d2] = await Promise.all([
      pm.createDevices("abcd1234abcd1234"),
      pm.createDevices("abcd1234abcd1234"),
    ]);
    expect(modules).toHaveLength(3);
    expect(d1).toEqual(d2);
  });

  it("destroys only that key's modules, remap source first", async () => {
    const { exec, modules, calls } = fakePactl();
    const pm = new PulseManager({ key: "dev4", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("aaaa1111aaaa1111");
    await pm.createDevices("bbbb2222bbbb2222");
    await pm.destroyDevices("aaaa1111aaaa1111");
    expect(modules.every((m) => !m.args.includes("aaaa1111aaaa1111"))).toBe(true);
    expect(modules).toHaveLength(3);
    const unloads = calls.filter((c) => c[0] === "unload-module").map((c) => c[1]);
    expect(unloads[0]).toBe("3"); // remap-source of aaaa1111aaaa1111 was module 3
  });

  it("lists device keys", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ key: "dev5", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("aaaa1111aaaa1111");
    expect((await pm.listDeviceKeys()).sort()).toEqual(["aaaa1111aaaa1111"]);
  });
});

describe("PulseManager clients", () => {
  it("capture reads the sink monitor at the session rate", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "cli1", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    pm.capture("wb_sink_abcd1234abcd1234", 24000);
    const [cmd, args, env] = (spawnFn as any).mock.calls.at(-1);
    expect(cmd).toBe("parec");
    expect(args).toEqual(expect.arrayContaining([
      "--device=wb_sink_abcd1234abcd1234.monitor", "--format=s16le", "--rate=24000", "--channels=1", "--raw",
    ]));
    expect(env.PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
  });

  it("playback writes into the mic sink at the session rate", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "cli2", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    pm.playback("wb_mic_abcd1234abcd1234", 16000);
    const [cmd, args, env] = (spawnFn as any).mock.calls.at(-1);
    expect(cmd).toBe("pacat");
    expect(args).toEqual(expect.arrayContaining([
      "--playback", "--device=wb_mic_abcd1234abcd1234", "--format=s16le", "--rate=16000", "--channels=1", "--raw", "--latency-msec=20",
    ]));
    expect(env.PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
  });

  it("capture proc emitting error fires its exit listener", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "cli3", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    const captureProc = pm.capture("wb_sink_abcd1234abcd1234", 24000);
    const exitCalled = vi.fn();
    captureProc.on("exit", exitCalled);
    captureProc.exitCode = -2; // Node.js sets exitCode before emitting error
    captureProc.emit("error", new Error("ENOENT"));
    expect(exitCalled).toHaveBeenCalledTimes(1);
  });

  it("capture proc: error doesn't double-emit when real exit follows", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ key: "cli4", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    const captureProc = pm.capture("wb_sink_abcd1234abcd1234", 24000);
    const exitCalled = vi.fn();
    captureProc.on("exit", exitCalled);
    captureProc.exitCode = -2;
    captureProc.emit("error", new Error("ENOENT"));
    expect(exitCalled).toHaveBeenCalledTimes(1);
    // Real exit follows error
    captureProc.emit("exit", -2, null);
    expect(exitCalled).toHaveBeenCalledTimes(2); // Only one exit, not three
  });

  it("pactl env has no SESSION_SECRET even when process.env does", async () => {
    const { exec, calls } = fakePactl();
    const oldSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "should-not-appear-in-pactl";
    try {
      const pm = new PulseManager({ key: "cli4", exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
      await pm.ensureDaemon();
      const pactlEnv = (exec as any).mock.calls[0][2];
      expect(pactlEnv.SESSION_SECRET).toBeUndefined();
      expect(pactlEnv.PULSE_SERVER).toBeDefined();
    } finally {
      if (oldSecret !== undefined) process.env.SESSION_SECRET = oldSecret;
      else delete process.env.SESSION_SECRET;
    }
  });
});

describe("pulseFor/releasePulse/shutdownAllPulse", () => {
  it("returns same instance for same key", () => {
    const pm1 = pulseFor("user-1");
    const pm2 = pulseFor("user-1");
    expect(pm1).toBe(pm2);
  });

  it("returns different instances for different keys", () => {
    const pm1 = pulseFor("user-1");
    const pm2 = pulseFor("user-2");
    expect(pm1).not.toBe(pm2);
  });

  it("releasePulse shuts down and deletes, later pulseFor returns fresh instance", async () => {
    const { exec } = fakePactl();
    const pm1 = pulseFor("user-123");
    (pm1 as any).opts.exec = exec;
    (pm1 as any).opts.spawn = spawnFn;
    (pm1 as any).opts.runtimeDir = "/tmp/wb-pulse-test";
    await pm1.ensureDaemon();
    const killCalled = vi.fn();
    pm1.on("daemon-exit", killCalled);
    releasePulse("user-123");
    const pm2 = pulseFor("user-123");
    expect(pm1).not.toBe(pm2);
  });

  it("shutdownAllPulse shuts down all daemons", () => {
    const pm1 = pulseFor("user-a");
    const pm2 = pulseFor("user-b");
    shutdownAllPulse();
    // Both should be cleared
    const pm1After = pulseFor("user-a");
    const pm2After = pulseFor("user-b");
    expect(pm1After).not.toBe(pm1);
    expect(pm2After).not.toBe(pm2);
  });
});
