import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

vi.mock("../src/config", () => ({
  config: { SESSION_SECRET: "test-session-secret-32-chars-long!!" },
}));

import { PulseManager, deviceKey, deviceNames, type Exec, type Spawn } from "../src/audio/pulse";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.exitCode = null;
  p.stdin = new PassThrough();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.kill = vi.fn(() => { p.exitCode = 0; p.emit("exit", 0, null); return true; });
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
  it("derives 8 hex chars from the user id, never the id itself", () => {
    const k = deviceKey("user-1");
    expect(k).toMatch(/^[0-9a-f]{8}$/);
    expect(k).not.toContain("user");
    expect(deviceKey("user-1")).toBe(k);
    expect(deviceKey("user-2")).not.toBe(k);
  });

  it("names the three devices from the key", () => {
    expect(deviceNames("abcd1234")).toEqual({
      sink: "wb_sink_abcd1234",
      mic: "wb_mic_abcd1234",
      source: "wb_src_abcd1234",
    });
  });
});

describe("PulseManager daemon", () => {
  it("spawns pulseaudio once, bumps epoch when pactl answers", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
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
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
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
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test", readyTimeoutMs: 300 });
    const p = pm.ensureDaemon();
    daemon.exitCode = 1;
    await expect(p).rejects.toThrow(/pulseaudio did not start/);
  });
});

describe("PulseManager devices", () => {
  it("creates sink, mic sink, and a remap source over the mic monitor", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    const d = await pm.createDevices("abcd1234");
    expect(d).toEqual(deviceNames("abcd1234"));
    expect(modules.map((m) => m.name)).toEqual(["module-null-sink", "module-null-sink", "module-remap-source"]);
    expect(modules[0].args).toContain("sink_name=wb_sink_abcd1234");
    expect(modules[1].args).toContain("sink_name=wb_mic_abcd1234");
    expect(modules[2].args).toContain("source_name=wb_src_abcd1234");
    expect(modules[2].args).toContain("master=wb_mic_abcd1234.monitor");
  });

  it("is idempotent", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("abcd1234");
    await pm.createDevices("abcd1234");
    expect(modules).toHaveLength(3);
  });

  it("destroys only that key's modules, remap source first", async () => {
    const { exec, modules, calls } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("aaaa1111");
    await pm.createDevices("bbbb2222");
    await pm.destroyDevices("aaaa1111");
    expect(modules.every((m) => !m.args.includes("aaaa1111"))).toBe(true);
    expect(modules).toHaveLength(3);
    const unloads = calls.filter((c) => c[0] === "unload-module").map((c) => c[1]);
    expect(unloads[0]).toBe("3"); // remap-source of aaaa1111 was module 3
  });

  it("lists keys and reaps those this process did not create or already released", async () => {
    const { exec, modules } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    await pm.createDevices("aaaa1111");
    // A leftover nobody in this process owns.
    modules.push({ idx: 99, name: "module-null-sink", args: "sink_name=wb_sink_dead0000 rate=48000 channels=1" });
    expect((await pm.listDeviceKeys()).sort()).toEqual(["aaaa1111", "dead0000"]);
    expect(await pm.reapOrphans()).toEqual(["dead0000"]);
    expect(await pm.listDeviceKeys()).toEqual(["aaaa1111"]);
  });
});

describe("PulseManager clients", () => {
  it("capture reads the sink monitor at the session rate", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    pm.capture("wb_sink_abcd1234", 24000);
    const [cmd, args, env] = (spawnFn as any).mock.calls.at(-1);
    expect(cmd).toBe("parec");
    expect(args).toEqual(expect.arrayContaining([
      "--device=wb_sink_abcd1234.monitor", "--format=s16le", "--rate=24000", "--channels=1", "--raw",
    ]));
    expect(env.PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
  });

  it("playback writes into the mic sink at the session rate", async () => {
    const { exec } = fakePactl();
    const pm = new PulseManager({ exec, spawn: spawnFn, runtimeDir: "/tmp/wb-pulse-test" });
    pm.playback("wb_mic_abcd1234", 16000);
    const [cmd, args] = (spawnFn as any).mock.calls.at(-1);
    expect(cmd).toBe("pacat");
    expect(args).toEqual(expect.arrayContaining([
      "--playback", "--device=wb_mic_abcd1234", "--format=s16le", "--rate=16000", "--channels=1", "--raw", "--latency-msec=20",
    ]));
  });
});
