# Browser Audio Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent hear and speak in a browser-based call (Zoom web, Slack huddle, Meet) running in its workbench Chromium, through an SSE audio-out stream, a long-lived chunked audio-in `POST`, and a `clear` call for interruption.

**Architecture:** A PulseAudio daemon, child of the server process, gives each user's Chromium a private null sink (speaker) and a remap source over a second null sink (mic), wired in at spawn through `PULSE_SINK`/`PULSE_SOURCE`. An `AudioSession` per user reads the speaker monitor with `parec` and frames it onto SSE. It paces agent audio into the mic sink with `pacat` at real time, from a server-side queue that `clear` can empty instantly. New REST routes, keyed by tab `session_id`, serve it. A streaming affinity forward pipes requests that land on the wrong pod to the owner.

**Tech Stack:** TypeScript, Fastify, Node `child_process` / `http`, PulseAudio (`pulseaudio`, `pactl`, `parec`, `pacat`), Chromium over CDP, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md`

## Global Constraints

- Feature flag `BROWSER_AUDIO_ENABLED`, default `false`. Off means no daemon, no devices, and the tools return `AUDIO_DISABLED`.
- `BROWSER_AUDIO_MAX_MINUTES`, default `120`: hard cap per audio session, ending with `max_duration`.
- Wire format: `pcm_s16le`, mono, `sample_rate` ∈ `16000 | 24000 | 48000`, default `24000`.
- SSE frames: `audio` every 40 ms, `playback` every 200 ms while queued plus once on drain, `ended` then close, `: ping` every 15 s.
- Uplink queue cap: 120 s of audio. Past it, stop reading the request body (backpressure); never drop.
- One audio session per user, bound to one tab. Second tab → `AUDIO_BUSY`. Second uplink → `409 uplink_busy`. A new SSE reader replaces the old one (`ended{replaced}`).
- `ended.reason` ∈ `stopped | tab_closed | browser_exit | replaced | max_duration | capture_failed | playback_failed | audio_daemon_exit`.
- Device names: `wb_sink_<key8>`, `wb_mic_<key8>`, `wb_src_<key8>`, where `key8` is 8 hex chars derived from an HMAC of the user id. Never the raw user id.
- Audio content is never logged.
- No DSP code in the repo. PulseAudio resamples (`parec --rate`, `pacat --rate`).
- Public repo hygiene (CLAUDE.md): synthetic fixtures only (`dev@example.com`, `user-1`), no secrets, no `Co-Authored-By` trailers.
- Ships as a release candidate (Docker image change).

### Deliberate deviations from the spec (decided while planning)

- The tab-not-found error reuses the existing `BROWSER_TAB_NOT_FOUND` code from `resolveTab` rather than a new `TAB_NOT_FOUND`, for consistency with every other `browser_*` tool.
- `stream_url`/`clear_url` are absolute (`SERVER_PUBLIC_URL` + path), so the agent can call them directly.
- `browser_audio_start` also returns `session_id`. With `restart: true` the browser restarts, the tab id changes, and the agent needs the new one.
- `key8` comes from its own HMAC (`browser-audio:<userId>`), not from the routing key. That keeps `audio/pulse.ts` from importing `cdp-bridge.ts`, which imports `browser-session.ts`, which will import `pulse.ts` (a cycle).
- The opt-in e2e flag is `TEST_AUDIO=1`, matching the existing `TEST_CHROMIUM=1` convention, rather than `AUDIO_E2E=1`.
- Each server process runs its own daemon in `$TMPDIR/wb-pulse-<pid>`, so `CLUSTER_ENABLED` workers never share or reap each other's devices.
- `played_ms` counts **agent** audio played (bytes taken from the queue), not silence padding. That is what `conversation.item.truncate` needs.

## Review Focus

1. **Meeting page navigates to another origin after `browser_audio_start`** (e.g. `zoom.us/j/…` → `app.zoom.us/wc/…`). Expected: the mic still works, because permission is re-granted on every main-frame navigation. Test in Task 5.
2. **Uplink chunks split a sample** (odd byte counts, as chunked HTTP freely produces). Expected: no click or pitch drift; bytes concatenate and only whole frames are paced. Test in Task 3.
3. **Agent drops the uplink connection mid-sentence** (client abort, not a clean end). Expected: the queue is dropped, the uplink slot is released so a new `POST` is accepted, and the session stays up for SSE. Test in Task 7.
4. **Session ends while the uplink `POST` is still streaming** (tab closed, stop, cap). Expected: the `POST` response comes back immediately with `{played_ms}` rather than hanging until the agent stops writing. Test in Task 7.
5. **Event loop stalls** (GC pause, slow request) longer than a few ticks. Expected: the pacer catches up by at most 5 frames (100 ms) and skips the rest, rather than bursting seconds of audio into `pacat`. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/src/config.ts` (modify) | two new env vars |
| `packages/server/src/audio/pulse.ts` (create) | PulseAudio daemon supervision, device create/destroy/list, `parec`/`pacat` spawners. Talks only to PulseAudio. |
| `packages/server/src/audio/session.ts` (create) | `AudioSession`: capture framing, SSE subscriber, uplink queue and real-time pacer, `clear`, end semantics. No HTTP, no CDP, no PulseAudio specifics (takes an `AudioIO`). |
| `packages/server/src/audio/manager.ts` (create) | per-user session map; `startAudio`/`stopAudio`/`getAudio`; mic permission over CDP; keep-alive; browser/daemon event hooks; orphan reaper. |
| `packages/server/src/audio/stream-forward.ts` (create) | streaming affinity forward over `node:http` (no timeouts, piped both ways). |
| `packages/server/src/audio/routes.ts` (create) | `GET/POST …/audio/stream`, `POST …/audio/clear`, raw-body scope. |
| `packages/server/src/auth/profile-chromium.ts` (modify) | `env` + `extraArgs` spawn options. |
| `packages/server/src/auth/browser-session.ts` (modify) | create devices at spawn, `WarmSession.audio`, `browserEvents` emitter (`tab-closed`, `session-exit`), destroy devices on exit. |
| `packages/server/src/plugins/internal/browser.ts` (modify) | `browser_audio_start`, `browser_audio_stop`. |
| `packages/server/src/index.ts` (modify) | register routes, init audio, kill daemon on shutdown. |
| `Dockerfile` (modify) | install `pulseaudio pulseaudio-utils`. |
| `scripts/test-audio-e2e.sh` (create) | run the real-PulseAudio e2e in a Linux container. |
| `packages/server/tests/audio-*.test.ts` (create) | unit/route tests; `audio-e2e.test.ts` gated on `TEST_AUDIO=1`. |
| `docs/findings/…`, `docs/site/_content/guides/browser-audio.md`, `docs/site/nav.json`, `docs/site/_content/integrations/browser.md`, `CLAUDE.md` | docs. |

All commands below run from `packages/server` unless stated otherwise.

---

### Task 1: Config flags and PulseAudio manager

**Files:**
- Modify: `packages/server/src/config.ts` (after `BROWSER_DISK_CACHE_MB`, line ~62)
- Create: `packages/server/src/audio/pulse.ts`
- Test: `packages/server/tests/audio-pulse.test.ts`

**Interfaces:**
- Consumes: `config.SESSION_SECRET`.
- Produces:
  - `config.BROWSER_AUDIO_ENABLED: boolean`, `config.BROWSER_AUDIO_MAX_MINUTES: number`
  - `interface PulseDevices { sink: string; mic: string; source: string }`
  - `deviceKey(userId: string): string` (8 hex chars)
  - `deviceNames(key: string): PulseDevices`
  - `type Exec = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>`
  - `type Spawn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess`
  - `class PulseManager extends EventEmitter` with `epoch: number`, `runtimeDir: string`, `clientEnv(): NodeJS.ProcessEnv`, `ensureDaemon(): Promise<void>`, `createDevices(key): Promise<PulseDevices>`, `destroyDevices(key): Promise<void>`, `listDeviceKeys(): Promise<string[]>`, `reapOrphans(): Promise<string[]>`, `capture(sink: string, rate: number): ChildProcess`, `playback(sink: string, rate: number): ChildProcess`, `shutdown(): void`; emits `"daemon-exit"`.
  - `const pulse: PulseManager` (process singleton)

- [ ] **Step 1: Add config vars**

In `src/config.ts`, after the `BROWSER_DISK_CACHE_MB` line:

```ts
  // Virtual speaker + mic per user's chromium so an agent can take part in a
  // browser call (docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md).
  // Off: no PulseAudio daemon, no devices, the audio tools answer AUDIO_DISABLED.
  BROWSER_AUDIO_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Hard cap on one audio session, so a forgotten uplink cannot hold a
  // chromium and two child processes forever.
  BROWSER_AUDIO_MAX_MINUTES: z.coerce.number().int().positive().default(120),
```

- [ ] **Step 2: Write the failing tests**

`tests/audio-pulse.test.ts`:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-pulse.test.ts`
Expected: FAIL, `Failed to resolve import "../src/audio/pulse"`.

- [ ] **Step 4: Implement `src/audio/pulse.ts`**

```ts
// The only code that talks to PulseAudio. A daemon per server process gives
// every user's chromium a private speaker and mic, so an agent can take part
// in a browser call (docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md).
//
// Per process, not per container: with CLUSTER_ENABLED each worker owns its
// own chromiums, and a shared daemon would let one worker's orphan sweep unload
// another worker's live devices.
import { spawn as nodeSpawn, execFile, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config";

export interface PulseDevices {
  /** Null sink chromium plays to; its `.monitor` is the call audio. */
  sink: string;
  /** Null sink the agent's audio is played into. */
  mic: string;
  /** Remap of `<mic>.monitor`; chromium's default input. */
  source: string;
}

/**
 * 8 hex chars naming one user's devices. Device names show up in `pactl`
 * output and process listings, so they carry a keyed hash, never the user id.
 */
export function deviceKey(userId: string): string {
  return createHmac("sha256", config.SESSION_SECRET)
    .update(`browser-audio:${userId}`)
    .digest("hex")
    .slice(0, 8);
}

export function deviceNames(key: string): PulseDevices {
  return { sink: `wb_sink_${key}`, mic: `wb_mic_${key}`, source: `wb_src_${key}` };
}

export type Exec = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
export type Spawn = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;

const defaultExec: Exec = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 5_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
  });

const defaultSpawn: Spawn = (cmd, args, env) => nodeSpawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });

interface ModuleRow { idx: string; name: string; args: string[] }

const KEY_RE = /^(?:sink_name|source_name)=wb_(?:sink|mic|src)_([0-9a-f]{8})$/;

export interface PulseManagerOpts {
  exec?: Exec;
  spawn?: Spawn;
  runtimeDir?: string;
  readyTimeoutMs?: number;
}

export class PulseManager extends EventEmitter {
  /**
   * Bumped on every daemon (re)start. A chromium spawned under an older epoch
   * was wired to a daemon that is gone, and does not reliably reattach.
   */
  epoch = 0;
  readonly runtimeDir: string;
  private daemon?: ChildProcess;
  private starting?: Promise<void>;
  /** Keys this process created and has not destroyed; everything else is an orphan. */
  private owned = new Set<string>();

  constructor(private readonly opts: PulseManagerOpts = {}) {
    super();
    this.runtimeDir = opts.runtimeDir ?? join(tmpdir(), `wb-pulse-${process.pid}`);
  }

  private get socket(): string {
    return join(this.runtimeDir, "native");
  }

  /** Env every client (chromium, parec, pacat, pactl) needs to reach this daemon. */
  clientEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PULSE_SERVER: `unix:${this.socket}` };
  }

  ensureDaemon(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.daemon && this.daemon.exitCode === null) return Promise.resolve();
    this.starting = this.startDaemon().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startDaemon(): Promise<void> {
    mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      HOME: this.runtimeDir,
      XDG_RUNTIME_DIR: this.runtimeDir,
      PULSE_RUNTIME_PATH: this.runtimeDir,
    };
    const args = [
      "-n", // no default.pa: only the modules we load, no hardware probing
      "--daemonize=no",
      "--exit-idle-time=-1",
      "--disallow-exit",
      "--use-pid-file=no",
      "--disable-shm=yes", // containers run with a tiny /dev/shm
      "--log-target=stderr",
      `--load=module-native-protocol-unix socket=${this.socket} auth-anonymous=1`,
    ];
    const proc = (this.opts.spawn ?? defaultSpawn)("pulseaudio", args, env);
    let stderrTail = "";
    proc.stderr?.on("data", (c: Buffer) => { stderrTail = (stderrTail + c.toString()).slice(-2000); });
    this.daemon = proc;
    proc.on("exit", () => {
      if (this.daemon !== proc) return;
      this.daemon = undefined;
      this.owned.clear();
      this.emit("daemon-exit");
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 5_000);
    for (;;) {
      try {
        await this.pactl(["info"]);
        break;
      } catch (e) {
        if (proc.exitCode !== null || Date.now() > deadline) {
          try { proc.kill("SIGKILL"); } catch { /* noop */ }
          throw new Error(`pulseaudio did not start: ${(e as Error).message} ${stderrTail.trim()}`.trim());
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    this.epoch += 1;
  }

  private pactl(args: string[]): Promise<string> {
    return (this.opts.exec ?? defaultExec)("pactl", args, this.clientEnv());
  }

  private async modules(): Promise<ModuleRow[]> {
    const out = await this.pactl(["list", "short", "modules"]);
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const [idx, name, rest = ""] = l.split("\t");
        return { idx, name, args: rest.split(/\s+/).filter(Boolean) };
      });
  }

  async createDevices(key: string): Promise<PulseDevices> {
    await this.ensureDaemon();
    const d = deviceNames(key);
    const have = await this.modules();
    const has = (kv: string) => have.some((m) => m.args.includes(kv));
    if (!has(`sink_name=${d.sink}`)) {
      await this.pactl(["load-module", "module-null-sink", `sink_name=${d.sink}`, "rate=48000", "channels=1"]);
    }
    if (!has(`sink_name=${d.mic}`)) {
      await this.pactl(["load-module", "module-null-sink", `sink_name=${d.mic}`, "rate=48000", "channels=1"]);
    }
    if (!has(`source_name=${d.source}`)) {
      await this.pactl(["load-module", "module-remap-source", `source_name=${d.source}`, `master=${d.mic}.monitor`]);
    }
    this.owned.add(key);
    return d;
  }

  async destroyDevices(key: string): Promise<void> {
    this.owned.delete(key);
    if (!this.daemon || this.daemon.exitCode !== null) return;
    const mine = (await this.modules()).filter((m) => m.args.some((a) => KEY_RE.exec(a)?.[1] === key));
    // The remap source holds the mic sink's monitor; unload it first.
    mine.sort((a, b) => Number(b.name === "module-remap-source") - Number(a.name === "module-remap-source"));
    for (const m of mine) {
      try { await this.pactl(["unload-module", m.idx]); } catch { /* already gone */ }
    }
  }

  async listDeviceKeys(): Promise<string[]> {
    const keys = new Set<string>();
    for (const m of await this.modules()) {
      for (const a of m.args) {
        const k = KEY_RE.exec(a)?.[1];
        if (k) keys.add(k);
      }
    }
    return [...keys];
  }

  /** Unload devices nobody in this process owns. Returns the keys reaped. */
  async reapOrphans(): Promise<string[]> {
    if (!this.daemon || this.daemon.exitCode !== null) return [];
    const orphans = (await this.listDeviceKeys()).filter((k) => !this.owned.has(k));
    for (const k of orphans) await this.destroyDevices(k);
    return orphans;
  }

  capture(sink: string, rate: number): ChildProcess {
    return (this.opts.spawn ?? defaultSpawn)(
      "parec",
      [`--device=${sink}.monitor`, "--format=s16le", `--rate=${rate}`, "--channels=1", "--raw", "--latency-msec=20"],
      this.clientEnv()
    );
  }

  playback(sink: string, rate: number): ChildProcess {
    return (this.opts.spawn ?? defaultSpawn)(
      "pacat",
      ["--playback", `--device=${sink}`, "--format=s16le", `--rate=${rate}`, "--channels=1", "--raw", "--latency-msec=20"],
      this.clientEnv()
    );
  }

  shutdown(): void {
    const d = this.daemon;
    this.daemon = undefined;
    this.owned.clear();
    try { d?.kill("SIGTERM"); } catch { /* noop */ }
  }
}

export const pulse = new PulseManager();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `NODE_ENV=test npx vitest run tests/audio-pulse.test.ts`
Expected: PASS (10 tests).

If "destroys only that key's modules, remap source first" fails on the index, check the fake's numbering: modules 1–3 belong to `aaaa1111`, so its remap source is `3`.

- [ ] **Step 6: Typecheck and commit**

```bash
npx tsc --noEmit -p .
git add src/config.ts src/audio/pulse.ts tests/audio-pulse.test.ts
git commit -m "feat(audio): PulseAudio manager for per-user virtual devices"
```

---

### Task 2: AudioSession: capture framing and the SSE subscriber

**Files:**
- Create: `packages/server/src/audio/session.ts`
- Test: `packages/server/tests/audio-session.test.ts`

**Interfaces:**
- Consumes: `PulseDevices` (Task 1).
- Produces (later tasks rely on these exact names):
  ```ts
  export type EndReason = "stopped" | "tab_closed" | "browser_exit" | "max_duration"
    | "capture_failed" | "playback_failed" | "audio_daemon_exit";
  export type AudioEvent =
    | { event: "audio"; data: { seq: number; pcm: string } }
    | { event: "playback"; data: { played_ms: number; buffered_ms: number } }
    | { event: "ended"; data: { reason: EndReason | "replaced" } };
  export type Subscriber = (e: AudioEvent) => void;
  export interface AudioProc { stdout?: Readable | null; stdin?: Writable | null; kill(signal?: NodeJS.Signals): boolean; on(ev: "exit", cb: () => void): unknown }
  export interface AudioIO { capture(sink: string, rate: number): AudioProc; playback(sink: string, rate: number): AudioProc }
  export interface AudioSessionOpts { userId: string; tabId: string; rate: number; devices: PulseDevices; io: AudioIO; maxMs: number; onEnd?: (reason: EndReason) => void }
  export class AudioSession {
    readonly userId: string; readonly tabId: string; readonly rate: number; readonly startedAt: number;
    ended?: EndReason;
    readonly whenEnded: Promise<EndReason>;
    start(): void;
    subscribe(sub: Subscriber): () => void;
    end(reason: EndReason): void;
    get totalPlayedMs(): number;
    // Task 3 adds: openUplink(), clear()
  }
  export const FRAME_OUT_MS = 40, TICK_MS = 20, PLAYBACK_EVENT_MS = 200, QUEUE_CAP_MS = 120_000, MAX_CATCHUP_TICKS = 5;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/audio-session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AudioSession, type AudioEvent, type AudioIO } from "../src/audio/session";

const DEVICES = { sink: "wb_sink_abcd1234", mic: "wb_mic_abcd1234", source: "wb_src_abcd1234" };

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stdin = new PassThrough();
  p.written = [] as Buffer[];
  p.stdin.on("data", (b: Buffer) => p.written.push(b));
  p.kill = vi.fn(() => true);
  return p;
}

let cap: any;
let play: any;
let io: AudioIO;

function makeSession(over: Partial<{ rate: number; maxMs: number; onEnd: any }> = {}) {
  const s = new AudioSession({
    userId: "user-1",
    tabId: "T1",
    rate: over.rate ?? 24000,
    devices: DEVICES,
    io,
    maxMs: over.maxMs ?? 60 * 60_000,
    onEnd: over.onEnd,
  });
  s.start();
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  cap = fakeProc();
  play = fakeProc();
  io = { capture: vi.fn(() => cap), playback: vi.fn(() => play) };
});
afterEach(() => vi.useRealTimers());

describe("AudioSession capture", () => {
  it("starts parec on the sink and pacat on the mic sink at the session rate", () => {
    makeSession({ rate: 16000 });
    expect(io.capture).toHaveBeenCalledWith("wb_sink_abcd1234", 16000);
    expect(io.playback).toHaveBeenCalledWith("wb_mic_abcd1234", 16000);
  });

  it("frames capture into 40 ms audio events with increasing seq", () => {
    const s = makeSession({ rate: 24000 }); // 40 ms = 960 samples = 1920 bytes
    const got: AudioEvent[] = [];
    s.subscribe((e) => got.push(e));
    cap.stdout.emit("data", Buffer.alloc(1000, 1));
    expect(got).toHaveLength(0);
    cap.stdout.emit("data", Buffer.alloc(3000, 2)); // 4000 total → 2 frames, 160 bytes left
    const audio = got.filter((e) => e.event === "audio") as any[];
    expect(audio.map((e) => e.data.seq)).toEqual([0, 1]);
    expect(Buffer.from(audio[0].data.pcm, "base64")).toHaveLength(1920);
  });

  it("keeps counting seq with no subscriber, so a reader sees the gap", () => {
    const s = makeSession({ rate: 24000 });
    cap.stdout.emit("data", Buffer.alloc(1920));
    const got: any[] = [];
    s.subscribe((e) => got.push(e));
    cap.stdout.emit("data", Buffer.alloc(1920));
    expect(got.filter((e) => e.event === "audio")[0].data.seq).toBe(1);
  });

  it("a new subscriber replaces the old one, which gets ended{replaced}", () => {
    const s = makeSession();
    const a: AudioEvent[] = [];
    const b: AudioEvent[] = [];
    s.subscribe((e) => a.push(e));
    s.subscribe((e) => b.push(e));
    expect(a).toEqual([{ event: "ended", data: { reason: "replaced" } }]);
    cap.stdout.emit("data", Buffer.alloc(1920));
    expect(a).toHaveLength(1);
    expect(b.filter((e) => e.event === "audio")).toHaveLength(1);
  });

  it("unsubscribe of a replaced subscriber does not detach the current one", () => {
    const s = makeSession();
    const b: AudioEvent[] = [];
    const unsubA = s.subscribe(() => undefined);
    s.subscribe((e) => b.push(e));
    unsubA();
    cap.stdout.emit("data", Buffer.alloc(1920));
    expect(b.filter((e) => e.event === "audio")).toHaveLength(1);
  });
});

describe("AudioSession end", () => {
  it("end() kills both processes, tells the subscriber, resolves whenEnded, calls onEnd once", async () => {
    const onEnd = vi.fn();
    const s = makeSession({ onEnd });
    const got: AudioEvent[] = [];
    s.subscribe((e) => got.push(e));
    s.end("stopped");
    s.end("tab_closed");
    expect(cap.kill).toHaveBeenCalled();
    expect(play.kill).toHaveBeenCalled();
    expect(got.at(-1)).toEqual({ event: "ended", data: { reason: "stopped" } });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("stopped");
    await expect(s.whenEnded).resolves.toBe("stopped");
  });

  it("subscribing after end gets ended immediately", () => {
    const s = makeSession();
    s.end("browser_exit");
    const got: AudioEvent[] = [];
    s.subscribe((e) => got.push(e));
    expect(got).toEqual([{ event: "ended", data: { reason: "browser_exit" } }]);
  });

  it("capture process death ends with capture_failed", () => {
    const s = makeSession();
    cap.emit("exit");
    expect(s.ended).toBe("capture_failed");
  });

  it("playback process death ends with playback_failed", () => {
    const s = makeSession();
    play.emit("exit");
    expect(s.ended).toBe("playback_failed");
  });

  it("exits caused by end() itself do not overwrite the reason", () => {
    const s = makeSession();
    s.end("stopped");
    cap.emit("exit");
    play.emit("exit");
    expect(s.ended).toBe("stopped");
  });

  it("ends with max_duration at the cap", () => {
    const s = makeSession({ maxMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    expect(s.ended).toBe("max_duration");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-session.test.ts`
Expected: FAIL, `Failed to resolve import "../src/audio/session"`.

- [ ] **Step 3: Implement `src/audio/session.ts` (capture half)**

```ts
// One user's live audio: call audio out (parec on the speaker monitor → 40 ms
// frames → one SSE subscriber) and agent audio in (a server-side queue paced
// into pacat at real time). No HTTP and no CDP here; the process spawners come
// in through AudioIO so the tests drive fake streams.
// Spec: docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md
import type { Readable, Writable } from "node:stream";
import type { PulseDevices } from "./pulse";

export const FRAME_OUT_MS = 40;
export const TICK_MS = 20;
export const PLAYBACK_EVENT_MS = 200;
export const QUEUE_CAP_MS = 120_000;
export const MAX_CATCHUP_TICKS = 5;

export type EndReason =
  | "stopped"
  | "tab_closed"
  | "browser_exit"
  | "max_duration"
  | "capture_failed"
  | "playback_failed"
  | "audio_daemon_exit";

export type AudioEvent =
  | { event: "audio"; data: { seq: number; pcm: string } }
  | { event: "playback"; data: { played_ms: number; buffered_ms: number } }
  | { event: "ended"; data: { reason: EndReason | "replaced" } };

export type Subscriber = (e: AudioEvent) => void;

export interface AudioProc {
  stdout?: Readable | null;
  stdin?: Writable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(ev: "exit", cb: () => void): unknown;
}

export interface AudioIO {
  capture(sink: string, rate: number): AudioProc;
  playback(sink: string, rate: number): AudioProc;
}

export interface AudioSessionOpts {
  userId: string;
  tabId: string;
  rate: number;
  devices: PulseDevices;
  io: AudioIO;
  maxMs: number;
  onEnd?: (reason: EndReason) => void;
}

export class AudioSession {
  readonly userId: string;
  readonly tabId: string;
  readonly rate: number;
  readonly startedAt = Date.now();
  ended?: EndReason;
  readonly whenEnded: Promise<EndReason>;

  private resolveEnded!: (r: EndReason) => void;
  private capture?: AudioProc;
  private playback?: AudioProc;
  private subscriber?: Subscriber;
  private seq = 0;
  private capBuf: Buffer = Buffer.alloc(0);
  private maxTimer?: ReturnType<typeof setTimeout>;
  protected totalPlayedBytes = 0;

  constructor(private readonly opts: AudioSessionOpts) {
    this.userId = opts.userId;
    this.tabId = opts.tabId;
    this.rate = opts.rate;
    this.whenEnded = new Promise((r) => { this.resolveEnded = r; });
  }

  /** PCM16 mono bytes per millisecond at this session's rate. */
  protected get bytesPerMs(): number {
    return (this.rate * 2) / 1000;
  }

  get totalPlayedMs(): number {
    return Math.round(this.totalPlayedBytes / this.bytesPerMs);
  }

  start(): void {
    const { io, devices, rate } = this.opts;
    this.capture = io.capture(devices.sink, rate);
    this.capture.stdout?.on("data", (c: Buffer) => this.onCapture(c));
    this.capture.on("exit", () => { if (!this.ended) this.end("capture_failed"); });

    this.playback = io.playback(devices.mic, rate);
    this.playback.stdin?.on("error", () => { /* the exit handler reports it */ });
    this.playback.on("exit", () => { if (!this.ended) this.end("playback_failed"); });

    this.maxTimer = setTimeout(() => this.end("max_duration"), this.opts.maxMs);
    this.maxTimer.unref?.();
  }

  private onCapture(chunk: Buffer): void {
    this.capBuf = this.capBuf.length ? Buffer.concat([this.capBuf, chunk]) : chunk;
    const n = Math.round(this.bytesPerMs * FRAME_OUT_MS);
    while (this.capBuf.length >= n) {
      const frame = this.capBuf.subarray(0, n);
      this.capBuf = this.capBuf.subarray(n);
      const seq = this.seq++;
      this.subscriber?.({ event: "audio", data: { seq, pcm: frame.toString("base64") } });
    }
  }

  /**
   * Attach the one SSE reader. Last reader wins: an agent reconnecting after a
   * network blip must not be refused by a stream nobody is reading any more.
   */
  subscribe(sub: Subscriber): () => void {
    if (this.ended) {
      sub({ event: "ended", data: { reason: this.ended } });
      return () => undefined;
    }
    const previous = this.subscriber;
    this.subscriber = sub;
    previous?.({ event: "ended", data: { reason: "replaced" } });
    return () => { if (this.subscriber === sub) this.subscriber = undefined; };
  }

  protected emit(e: AudioEvent): void {
    this.subscriber?.(e);
  }

  end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = reason;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.onEnded();
    try { this.capture?.kill("SIGTERM"); } catch { /* noop */ }
    try { this.playback?.kill("SIGTERM"); } catch { /* noop */ }
    const sub = this.subscriber;
    this.subscriber = undefined;
    sub?.({ event: "ended", data: { reason } });
    this.resolveEnded(reason);
    this.opts.onEnd?.(reason);
  }

  /** Hook for the uplink half (Task 3) to release its waiters. */
  protected onEnded(): void { /* overridden in Task 3 by direct edit */ }
}
```

> Task 3 replaces the `onEnded` placeholder body and adds the pacer. Keeping it as a method here keeps `end()` unchanged between tasks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_ENV=test npx vitest run tests/audio-session.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/audio/session.ts tests/audio-session.test.ts
git commit -m "feat(audio): AudioSession capture framing and SSE subscriber"
```

---

### Task 3: AudioSession: uplink queue, real-time pacer, clear

**Files:**
- Modify: `packages/server/src/audio/session.ts`
- Test: `packages/server/tests/audio-session.test.ts` (append)

**Interfaces:**
- Consumes: Task 2's `AudioSession`.
- Produces:
  ```ts
  export interface Uplink {
    write(chunk: Buffer): Promise<void>;   // resolves once the queue is under the cap (backpressure)
    end(): Promise<{ played_ms: number }>; // resolves when the queue has drained or the session ended
    abort(): void;                         // client went away: drop queue, release the slot
    readonly sessionEnded: Promise<EndReason>;
  }
  AudioSession.openUplink(): Uplink | "busy" | "ended";
  AudioSession.clear(): { played_ms: number; cleared_ms: number };
  ```
  `played_ms` is agent audio taken from the queue since this uplink opened. Silence padding is not counted.

- [ ] **Step 1: Append failing tests**

Append to `tests/audio-session.test.ts`:

```ts
describe("AudioSession uplink pacing", () => {
  // 24 kHz: 20 ms tick = 960 bytes, 1 ms = 48 bytes.
  it("feeds pacat one 20 ms frame per tick, silence when the queue is empty", () => {
    makeSession();
    vi.advanceTimersByTime(60);
    expect(play.written).toHaveLength(3);
    for (const b of play.written) {
      expect(b).toHaveLength(960);
      expect(b.every((x: number) => x === 0)).toBe(true);
    }
  });

  it("plays queued audio in order and counts played_ms", async () => {
    const s = makeSession();
    const up = s.openUplink();
    if (typeof up === "string") throw new Error(up);
    await up.write(Buffer.alloc(960 * 2, 7)); // 40 ms
    vi.advanceTimersByTime(20);
    expect(play.written.at(-1).every((x: number) => x === 7)).toBe(true);
    vi.advanceTimersByTime(20);
    vi.advanceTimersByTime(20);
    expect(play.written.at(-1).every((x: number) => x === 0)).toBe(true);
    const r = up.end();
    await expect(r).resolves.toEqual({ played_ms: 40 });
  });

  it("joins chunks that split a sample without shifting the stream", async () => {
    const s = makeSession();
    const up = s.openUplink() as any;
    const pcm = Buffer.alloc(960);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    await up.write(pcm.subarray(0, 301)); // odd split
    await up.write(pcm.subarray(301));
    vi.advanceTimersByTime(20);
    const out: Buffer = play.written.at(-1);
    for (let i = 0; i < out.length; i += 2) expect(out.readInt16LE(i)).toBe(1000);
  });

  it("end() waits for the queue to drain, then resolves", async () => {
    const s = makeSession();
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(960 * 5)); // 100 ms
    let done = false;
    up.end().then(() => { done = true; });
    vi.advanceTimersByTime(80);
    await Promise.resolve();
    expect(done).toBe(false);
    vi.advanceTimersByTime(20);
    await vi.waitFor(() => expect(done).toBe(true));
  });

  it("refuses a second uplink while one is open, accepts after it ends", async () => {
    const s = makeSession();
    const up = s.openUplink() as any;
    expect(s.openUplink()).toBe("busy");
    await up.end();
    expect(typeof s.openUplink()).toBe("object");
  });

  it("abort() drops the queue and frees the slot", async () => {
    const s = makeSession();
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(960 * 10));
    up.abort();
    vi.advanceTimersByTime(20);
    expect(play.written.at(-1).every((x: number) => x === 0)).toBe(true);
    expect(typeof s.openUplink()).toBe("object");
  });

  it("applies backpressure at the 120 s cap and releases it as audio plays", async () => {
    const s = makeSession({ rate: 16000 }); // 32 bytes/ms; cap = 3_840_000 bytes
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(3_840_000 - 640));
    let released = false;
    up.write(Buffer.alloc(640 * 2)).then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    vi.advanceTimersByTime(40); // two ticks play 1280 bytes → under the cap
    await vi.waitFor(() => expect(released).toBe(true));
  });

  it("emits playback marks every 200 ms while queued and once on drain", async () => {
    const s = makeSession();
    const got: AudioEvent[] = [];
    s.subscribe((e) => got.push(e));
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(48 * 300)); // 300 ms
    vi.advanceTimersByTime(400);
    const marks = got.filter((e) => e.event === "playback") as any[];
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(marks.at(-1).data).toEqual({ played_ms: 300, buffered_ms: 0 });
    expect(marks.filter((m) => m.data.buffered_ms === 0)).toHaveLength(1);
  });

  it("catches up at most 5 ticks after an event-loop stall", () => {
    makeSession();
    vi.advanceTimersByTime(20);
    const before = play.written.length;
    // Simulate a 1 s stall: the clock jumps without the interval firing.
    vi.setSystemTime(Date.now() + 1_000);
    vi.advanceTimersByTime(20);
    expect(play.written.length - before).toBeLessThanOrEqual(5 + 1);
  });
});

describe("AudioSession clear", () => {
  it("empties the queue at once and reports played and cleared ms", async () => {
    const s = makeSession();
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(48 * 1000)); // 1 s
    vi.advanceTimersByTime(200);
    expect(s.clear()).toEqual({ played_ms: 200, cleared_ms: 800 });
    vi.advanceTimersByTime(20);
    expect(play.written.at(-1).every((x: number) => x === 0)).toBe(true);
    await expect(up.end()).resolves.toEqual({ played_ms: 200 });
  });

  it("is a no-op with no uplink", () => {
    const s = makeSession();
    expect(s.clear()).toEqual({ played_ms: 0, cleared_ms: 0 });
  });

  it("played_ms restarts per uplink, totalPlayedMs does not", async () => {
    const s = makeSession();
    const a = s.openUplink() as any;
    await a.write(Buffer.alloc(48 * 40));
    vi.advanceTimersByTime(40);
    await a.end();
    const b = s.openUplink() as any;
    await b.write(Buffer.alloc(48 * 20));
    vi.advanceTimersByTime(20);
    await expect(b.end()).resolves.toEqual({ played_ms: 20 });
    expect(s.totalPlayedMs).toBe(60);
  });
});

describe("AudioSession end with an open uplink", () => {
  it("resolves a pending end(), a blocked write(), and sessionEnded", async () => {
    const s = makeSession({ rate: 16000 });
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(3_840_000 - 32)); // just under the cap
    const blocked = up.write(Buffer.alloc(64));    // crosses it: waits for room
    const ending = up.end();
    s.end("tab_closed");
    await expect(blocked).resolves.toBeUndefined();
    await expect(ending).resolves.toEqual({ played_ms: 0 });
    await expect(up.sessionEnded).resolves.toBe("tab_closed");
    expect(s.openUplink()).toBe("ended");
  });

  it("stops the pacer", () => {
    const s = makeSession();
    s.end("stopped");
    const n = play.written.length;
    vi.advanceTimersByTime(100);
    expect(play.written.length).toBe(n);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-session.test.ts`
Expected: FAIL, `s.openUplink is not a function`.

- [ ] **Step 3: Implement the uplink half**

In `src/audio/session.ts`, add the `Uplink` interface after `AudioSessionOpts`:

```ts
export interface Uplink {
  /** Queue agent PCM. Resolves once the queue is under QUEUE_CAP_MS — the caller awaits it before reading more of the request body, which is the backpressure. */
  write(chunk: Buffer): Promise<void>;
  /** The agent finished sending: resolves when the queue has played out, or at once if the session ended. */
  end(): Promise<{ played_ms: number }>;
  /** The agent went away: drop what is queued and free the slot. */
  abort(): void;
  readonly sessionEnded: Promise<EndReason>;
}
```

Add these fields to the class (next to the existing private fields):

```ts
  private pacer?: ReturnType<typeof setInterval>;
  private pacerStart = 0;
  private ticksWritten = 0;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private uplink?: object;
  private uplinkPlayedBytes = 0;
  private lastMark = 0;
  private wasBuffered = false;
  private roomWaiters: Array<() => void> = [];
  private drainWaiters: Array<() => void> = [];
```

In `start()`, after the playback wiring and before the max timer:

```ts
    this.pacerStart = Date.now();
    this.pacer = setInterval(() => this.tick(), TICK_MS);
    this.pacer.unref?.();
```

Replace the `onEnded` placeholder with:

```ts
  protected onEnded(): void {
    if (this.pacer) clearInterval(this.pacer);
    this.dropQueue();
    this.uplink = undefined;
    this.wake(this.drainWaiters);
  }
```

Add the remaining methods to the class:

```ts
  private get capBytes(): number {
    return Math.round(this.bytesPerMs * QUEUE_CAP_MS);
  }

  private get tickBytes(): number {
    return Math.round(this.bytesPerMs * TICK_MS);
  }

  private wake(list: Array<() => void>): void {
    for (const w of list.splice(0)) w();
  }

  private dropQueue(): number {
    const dropped = this.queuedBytes;
    this.queue = [];
    this.queuedBytes = 0;
    this.wake(this.roomWaiters);
    return dropped;
  }

  /**
   * Hand pacat the frames real time says are due. Pacing lives here and not in
   * pacat so the queue — and therefore clear() — stays in this process, where
   * it can be emptied instantly. A stalled event loop catches up by at most
   * MAX_CATCHUP_TICKS; the rest is skipped rather than burst into the mic.
   */
  private tick(): void {
    if (this.ended) return;
    const elapsedTicks = Math.floor((Date.now() - this.pacerStart) / TICK_MS);
    let due = elapsedTicks - this.ticksWritten;
    if (due > MAX_CATCHUP_TICKS) {
      this.ticksWritten = elapsedTicks - MAX_CATCHUP_TICKS;
      due = MAX_CATCHUP_TICKS;
    }
    for (let i = 0; i < due; i++) {
      try { this.playback?.stdin?.write(this.takeFrame()); } catch { /* exit handler reports it */ }
      this.ticksWritten += 1;
    }
    if (due > 0) this.afterPlay();
  }

  private takeFrame(): Buffer {
    const n = this.tickBytes;
    const out = Buffer.alloc(n); // zero = silence
    let off = 0;
    while (off < n && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, n - off);
      head.copy(out, off, 0, take);
      off += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    this.queuedBytes -= off;
    this.uplinkPlayedBytes += off;
    this.totalPlayedBytes += off;
    return out;
  }

  private mark(): void {
    this.lastMark = Date.now();
    this.emit({
      event: "playback",
      data: {
        played_ms: Math.round(this.uplinkPlayedBytes / this.bytesPerMs),
        buffered_ms: Math.round(this.queuedBytes / this.bytesPerMs),
      },
    });
  }

  private afterPlay(): void {
    if (this.queuedBytes < this.capBytes) this.wake(this.roomWaiters);
    if (this.queuedBytes > 0) {
      if (Date.now() - this.lastMark >= PLAYBACK_EVENT_MS) this.mark();
    } else if (this.wasBuffered) {
      this.mark();
      this.wake(this.drainWaiters);
    }
    this.wasBuffered = this.queuedBytes > 0;
  }

  openUplink(): Uplink | "busy" | "ended" {
    if (this.ended) return "ended";
    if (this.uplink) return "busy";
    const token = {};
    this.uplink = token;
    this.uplinkPlayedBytes = 0;
    const mine = () => this.uplink === token;
    const result = () => ({ played_ms: Math.round(this.uplinkPlayedBytes / this.bytesPerMs) });
    return {
      sessionEnded: this.whenEnded,
      write: (chunk) => {
        if (!mine() || this.ended || chunk.length === 0) return Promise.resolve();
        this.queue.push(Buffer.from(chunk)); // copy: the caller may reuse its buffer
        this.queuedBytes += chunk.length;
        this.wasBuffered = true;
        if (this.queuedBytes < this.capBytes) return Promise.resolve();
        return new Promise<void>((r) => this.roomWaiters.push(r));
      },
      end: async () => {
        if (mine() && !this.ended && this.queuedBytes > 0) {
          await new Promise<void>((r) => this.drainWaiters.push(r));
        }
        const r = result();
        if (mine()) this.uplink = undefined;
        return r;
      },
      abort: () => {
        if (!mine()) return;
        this.dropQueue();
        this.uplink = undefined;
        this.wake(this.drainWaiters);
      },
    };
  }

  /** Interrupt: drop everything not yet played. */
  clear(): { played_ms: number; cleared_ms: number } {
    if (!this.uplink) return { played_ms: 0, cleared_ms: 0 };
    const cleared = this.dropQueue();
    const out = {
      played_ms: Math.round(this.uplinkPlayedBytes / this.bytesPerMs),
      cleared_ms: Math.round(cleared / this.bytesPerMs),
    };
    if (this.wasBuffered) {
      this.wasBuffered = false;
      this.mark();
      this.wake(this.drainWaiters);
    }
    return out;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_ENV=test npx vitest run tests/audio-session.test.ts`
Expected: PASS (all Task 2 and Task 3 tests).

If "catches up at most 5 ticks" fails: `vi.setSystemTime` moves `Date.now()` without firing intervals, so the next `advanceTimersByTime(20)` fires one tick that sees ~51 elapsed ticks. The cap must hold there.

- [ ] **Step 5: Commit**

```bash
git add src/audio/session.ts tests/audio-session.test.ts
git commit -m "feat(audio): uplink queue, real-time pacer, clear with played_ms"
```

---

### Task 4: Wire devices into Chromium spawn and expose browser lifecycle events

**Files:**
- Modify: `packages/server/src/auth/profile-chromium.ts` (`spawnProfileChromium`, lines ~158–203)
- Modify: `packages/server/src/auth/browser-session.ts` (`attachTab`, `WarmSession`, `startSession`, `closeTab`, `closeBrowserSession`)
- Test: `packages/server/tests/audio-browser-wiring.test.ts`

**Interfaces:**
- Consumes: `pulse`, `deviceKey`, `PulseDevices` (Task 1).
- Produces:
  - `spawnProfileChromium(userId, opts: { startUrl?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[] })`
  - `WarmSession.audio?: { key: string; devices: PulseDevices; epoch: number }`
  - `export const browserEvents: EventEmitter`, emitting `"tab-closed"(userId: string, tabId: string)` and `"session-exit"(userId: string)`.

- [ ] **Step 1: Write the failing tests**

`tests/audio-browser-wiring.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { cfg, spawnMock, pulseMock, cdpInstances } = vi.hoisted(() => ({
  cfg: {
    BROWSER_AUDIO_ENABLED: true,
    BROWSER_TAB_LIMIT: 8,
    BROWSER_SESSION_TTL_SECONDS: 300,
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    DATABASE_URL: process.env.DATABASE_URL,
  },
  spawnMock: vi.fn(),
  pulseMock: {
    epoch: 3,
    ensureDaemon: vi.fn(async () => undefined),
    createDevices: vi.fn(async (k: string) => ({ sink: `wb_sink_${k}`, mic: `wb_mic_${k}`, source: `wb_src_${k}` })),
    destroyDevices: vi.fn(async () => undefined),
    clientEnv: vi.fn(() => ({ PULSE_SERVER: "unix:/tmp/wb-pulse-test/native" })),
  },
  cdpInstances: [] as any[],
}));

vi.mock("../src/config", () => ({ config: cfg }));
vi.mock("../src/auth/profile-chromium", () => ({
  spawnProfileChromium: spawnMock,
  activeProfiles: new Set<string>(),
  userProfileDir: (u: string) => `/tmp/profiles/${u}`,
}));
vi.mock("../src/audio/pulse", () => ({ pulse: pulseMock, deviceKey: () => "abcd1234" }));
vi.mock("../src/reap/profiles", () => ({ trimProfileCaches: vi.fn(async () => 0) }));
vi.mock("../src/auth/browser-downloads", () => ({ cancelDownloads: vi.fn(), configureDownloads: vi.fn() }));
vi.mock("ws", () => {
  class FakeWs extends EventEmitter {
    constructor() { super(); cdpInstances.push(this); setTimeout(() => this.emit("open"), 0); }
    send() {}
    close() { this.emit("close"); }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

import { ensureSession, closeTab, browserEvents, getWarmSession, closeBrowserSession } from "../src/auth/browser-session";

let proc: any;
beforeEach(() => {
  proc = new EventEmitter();
  proc.kill = vi.fn();
  spawnMock.mockResolvedValue({
    proc,
    remotePort: 9222,
    cdpBrowserWsUrl: "ws://127.0.0.1:9222/devtools/browser/x",
    cdpPageWsUrl: "ws://127.0.0.1:9222/devtools/page/T0",
    cdpPageTargetId: "T0",
    timings: {},
  });
  cfg.BROWSER_AUDIO_ENABLED = true;
});

describe("chromium spawn with audio", () => {
  it("creates devices first and passes PULSE_SINK/PULSE_SOURCE + autoplay flag", async () => {
    const s = await ensureSession("user-1");
    expect(pulseMock.createDevices).toHaveBeenCalledWith("abcd1234");
    const [, opts] = spawnMock.mock.calls.at(-1);
    expect(opts.env.PULSE_SINK).toBe("wb_sink_abcd1234");
    expect(opts.env.PULSE_SOURCE).toBe("wb_src_abcd1234");
    expect(opts.env.PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
    expect(opts.extraArgs).toContain("--autoplay-policy=no-user-gesture-required");
    expect(s.audio).toEqual({ key: "abcd1234", devices: expect.any(Object), epoch: 3 });
    await closeBrowserSession("user-1");
  });

  it("spawns without audio when the flag is off", async () => {
    cfg.BROWSER_AUDIO_ENABLED = false;
    const s = await ensureSession("user-2");
    const [, opts] = spawnMock.mock.calls.at(-1);
    expect(opts.env).toBeUndefined();
    expect(s.audio).toBeUndefined();
    await closeBrowserSession("user-2");
  });

  it("still opens the browser when device creation fails", async () => {
    pulseMock.createDevices.mockRejectedValueOnce(new Error("pulseaudio did not start"));
    const s = await ensureSession("user-3");
    expect(s.audio).toBeUndefined();
    await closeBrowserSession("user-3");
  });

  it("destroys devices and emits session-exit when chromium exits", async () => {
    await ensureSession("user-4");
    const exited = vi.fn();
    browserEvents.on("session-exit", exited);
    proc.emit("exit", 0, null);
    expect(exited).toHaveBeenCalledWith("user-4");
    expect(pulseMock.destroyDevices).toHaveBeenCalledWith("abcd1234");
    expect(getWarmSession("user-4")).toBeUndefined();
    browserEvents.off("session-exit", exited);
  });

  it("emits tab-closed from closeTab", async () => {
    await ensureSession("user-5");
    const closed = vi.fn();
    browserEvents.on("tab-closed", closed);
    // Not awaited: closeTab then waits on Target.closeTarget, which the fake
    // socket never answers. The event fires synchronously before that await.
    void closeTab("user-5", "T0");
    expect(closed).toHaveBeenCalledWith("user-5", "T0");
    browserEvents.off("tab-closed", closed);
    await closeBrowserSession("user-5");
  });
});
```

> If `browser-session.ts` imports more modules than the mocks above cover, which shows up as a module-not-found or real side effect on import, add a `vi.mock` for that module in the same style. Copy the factory shapes from `tests/browser-session.test.ts`, which already mocks this module's dependencies. Do not change production code to satisfy the test harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-browser-wiring.test.ts`
Expected: FAIL. `browserEvents` is undefined, and `opts.env` is undefined in the first test.

- [ ] **Step 3: Add spawn options in `profile-chromium.ts`**

Change the signature and spawn call:

```ts
export async function spawnProfileChromium(
  userId: string,
  opts: { startUrl?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[] } = {}
): Promise<SpawnedChromium> {
```

After the `"--disable-dev-shm-usage",` line and before `if (opts.startUrl) args.push(opts.startUrl);`:

```ts
  if (opts.extraArgs) args.push(...opts.extraArgs);
```

And the spawn:

```ts
  const proc = spawn(execPath, args, { stdio: ["ignore", "ignore", "pipe"], detached: false, env: opts.env ?? process.env });
```

- [ ] **Step 4: Wire `browser-session.ts`**

Imports (top of file):

```ts
import { EventEmitter } from "node:events";
import { pulse, deviceKey, type PulseDevices } from "../audio/pulse";
```

Below the imports:

```ts
/**
 * Tab and process lifecycle, for subsystems that hang state off a tab (the
 * audio pipeline). An emitter rather than an import of those subsystems keeps
 * this module free of cycles.
 *   "tab-closed"   (userId, tabId)
 *   "session-exit" (userId)
 */
export const browserEvents = new EventEmitter();
browserEvents.setMaxListeners(50);
```

In `attachTab`'s `onGone` callback, after `s.tabs.delete(targetId)`:

```ts
    if (cur && cur.cdp === cdp) {
      s.tabs.delete(targetId);
      browserEvents.emit("tab-closed", s.userId, targetId);
    }
```

(Replace the one-line `if (cur && cur.cdp === cdp) s.tabs.delete(targetId);` with that block.)

Add to `interface WarmSession` after `downloadRouting?`:

```ts
  /**
   * Virtual speaker/mic this chromium was spawned onto, when BROWSER_AUDIO_ENABLED.
   * `epoch` is the PulseAudio daemon generation at spawn: a chromium from an
   * older epoch is wired to a dead daemon and must restart before audio works.
   */
  audio?: { key: string; devices: PulseDevices; epoch: number };
```

In `startSession`, replace `const spawned = await spawnProfileChromium(userId, {});` with:

```ts
    // Devices must exist before spawn: chromium reads PULSE_SINK/PULSE_SOURCE
    // once, at startup. A failure here costs the user audio, not the browser.
    let audio: WarmSession["audio"];
    if (config.BROWSER_AUDIO_ENABLED) {
      try {
        await pulse.ensureDaemon();
        const key = deviceKey(userId);
        audio = { key, devices: await pulse.createDevices(key), epoch: pulse.epoch };
      } catch (e) {
        console.warn(`[browser] audio devices unavailable:`, (e as Error).message);
      }
    }
    const spawned = await spawnProfileChromium(
      userId,
      audio
        ? {
            env: { ...pulse.clientEnv(), PULSE_SINK: audio.devices.sink, PULSE_SOURCE: audio.devices.source },
            extraArgs: ["--autoplay-policy=no-user-gesture-required"],
          }
        : {}
    );
```

Add `audio,` to the `const session: WarmSession = { … }` literal, after `authWs,`.

In the `spawned.proc.on("exit", …)` handler, after `try { session.authWs?.close(); } catch { /* noop */ }`:

```ts
      if (session.audio) void pulse.destroyDevices(session.audio.key).catch(() => undefined);
      browserEvents.emit("session-exit", userId);
```

In `closeTab`, after `s.tabs.delete(tabId);`:

```ts
  browserEvents.emit("tab-closed", userId, tabId);
```

In `closeBrowserSession`, after `warmSessions.delete(userId);`:

```ts
  browserEvents.emit("session-exit", userId);
```

(The process `exit` handler emits again; listeners must be idempotent, and the audio manager's `end()` is.)

- [ ] **Step 5: Run the new and existing browser tests**

Run: `NODE_ENV=test npx vitest run tests/audio-browser-wiring.test.ts tests/browser-session.test.ts tests/profile-chromium.test.ts tests/browser-meta-tools.test.ts`
Expected: PASS. If an existing suite mocks `../src/config` without `BROWSER_AUDIO_ENABLED`, it reads `undefined` (falsy), so audio stays off and nothing changes. If an existing suite fails because it now imports `../src/audio/pulse` for real, add `vi.mock("../src/audio/pulse", () => ({ pulse: {}, deviceKey: () => "abcd1234" }))` to that suite.

- [ ] **Step 6: Commit**

```bash
git add src/auth/profile-chromium.ts src/auth/browser-session.ts tests/audio-browser-wiring.test.ts
git commit -m "feat(audio): spawn chromium onto per-user PulseAudio devices"
```

---

### Task 5: Audio manager: start/stop, mic permission, lifecycle hooks

**Files:**
- Create: `packages/server/src/audio/manager.ts`
- Test: `packages/server/tests/audio-manager.test.ts`

**Interfaces:**
- Consumes: `AudioSession`, `EndReason` (Tasks 2–3); `pulse` (Task 1); `getWarmSession`, `getTab`, `touchTab`, `browserClient`, `closeBrowserSession`, `openTab`, `navigate`, `browserEvents`, `Tab` (browser-session, Task 4); `config.BROWSER_AUDIO_ENABLED`, `config.BROWSER_AUDIO_MAX_MINUTES`.
- Produces:
  ```ts
  export type StartAudioResult =
    | { ok: true; session: AudioSession; session_id: string; restarted: boolean }
    | { ok: false; error: "AUDIO_DISABLED" | "BROWSER_TAB_NOT_FOUND" | "AUDIO_BUSY" | "BROWSER_RESTART_REQUIRED"; detail: string; session_id?: string };
  export async function startAudio(userId: string, tabId: string, rate: number, opts?: { restart?: boolean }): Promise<StartAudioResult>;
  export function stopAudio(userId: string, tabId: string): { played_ms: number; duration_ms: number };
  export function getAudio(userId: string): AudioSession | undefined;
  export function initBrowserAudio(): void;   // wire events + reaper; idempotent
  export const KEEPALIVE_MS = 10_000;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/audio-manager.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const cfg = vi.hoisted(() => ({ BROWSER_AUDIO_ENABLED: true, BROWSER_AUDIO_MAX_MINUTES: 120 }));
const warm = new Map<string, any>();
const tabs = new Map<string, any>();

vi.mock("../src/config", () => ({ config: cfg }));
// Factories import EventEmitter themselves: vi.hoisted runs before imports and
// `require` does not exist in an ESM test file.
vi.mock("../src/audio/pulse", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    pulse: Object.assign(new EventEmitter(), {
      epoch: 1,
      ensureDaemon: vi.fn(async () => undefined),
      reapOrphans: vi.fn(async () => []),
      capture: vi.fn(),
      playback: vi.fn(),
    }),
  };
});
vi.mock("../src/auth/browser-session", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    browserEvents: new EventEmitter(),
    getWarmSession: vi.fn(),
    getTab: vi.fn(),
    touchTab: vi.fn(),
    browserClient: vi.fn(),
    closeBrowserSession: vi.fn(async () => undefined),
    openTab: vi.fn(),
    navigate: vi.fn(async () => ({})),
  };
});

import { startAudio, stopAudio, getAudio, initBrowserAudio, KEEPALIVE_MS } from "../src/audio/manager";
import * as bsModule from "../src/auth/browser-session";
import { pulse as pulseModule } from "../src/audio/pulse";

const bs = bsModule as any;
const pulseMock = pulseModule as any;

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stdin = new PassThrough();
  p.kill = vi.fn(() => true);
  return p;
}

function fakeTab(id: string) {
  const cdp = new EventEmitter() as any;
  cdp.send = vi.fn();
  cdp.on = vi.fn((m: string, fn: any) => { EventEmitter.prototype.on.call(cdp, m, fn); return () => cdp.removeListener(m, fn); });
  return { id, cdp };
}

let browser: { send: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  cfg.BROWSER_AUDIO_ENABLED = true;
  pulseMock.epoch = 1;
  pulseMock.capture.mockImplementation(() => fakeProc());
  pulseMock.playback.mockImplementation(() => fakeProc());
  warm.clear();
  tabs.clear();
  warm.set("user-1", { userId: "user-1", audio: { key: "abcd1234", devices: { sink: "s", mic: "m", source: "src" }, epoch: 1 } });
  tabs.set("T1", fakeTab("T1"));
  tabs.set("T2", fakeTab("T2"));
  bs.getWarmSession.mockImplementation((u: string) => warm.get(u));
  bs.getTab.mockImplementation((_u: string, id: string) => tabs.get(id));
  browser = { send: vi.fn(async (method: string) => method === "Target.getTargetInfo"
    ? { targetInfo: { url: "https://meet.example.com/abc-defg" } }
    : {}) };
  bs.browserClient.mockResolvedValue(browser);
  initBrowserAudio();
});

afterEach(() => {
  for (const u of ["user-1"]) { const s = getAudio(u); if (s) stopAudio(u, s.tabId); }
  vi.useRealTimers();
});

describe("startAudio", () => {
  it("binds the tab, starts the session, grants the mic to the tab's origin", async () => {
    const r = await startAudio("user-1", "T1", 24000);
    expect(r).toMatchObject({ ok: true, session_id: "T1", restarted: false });
    expect(getAudio("user-1")?.tabId).toBe("T1");
    expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: "https://meet.example.com",
    });
  });

  it("is refused when the flag is off", async () => {
    cfg.BROWSER_AUDIO_ENABLED = false;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "AUDIO_DISABLED" });
  });

  it("refuses an unknown tab", async () => {
    expect(await startAudio("user-1", "nope", 24000)).toMatchObject({ ok: false, error: "BROWSER_TAB_NOT_FOUND" });
  });

  it("refuses a second tab while one is bound, naming the bound tab", async () => {
    await startAudio("user-1", "T1", 24000);
    expect(await startAudio("user-1", "T2", 24000)).toMatchObject({ ok: false, error: "AUDIO_BUSY", session_id: "T1" });
  });

  it("returns the existing session for the same tab and rate", async () => {
    const a = await startAudio("user-1", "T1", 24000);
    const b = await startAudio("user-1", "T1", 24000);
    expect((b as any).session).toBe((a as any).session);
  });

  it("asks for a restart when chromium has no devices or an old epoch", async () => {
    warm.get("user-1").audio.epoch = 0;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "BROWSER_RESTART_REQUIRED" });
    warm.get("user-1").audio = undefined;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "BROWSER_RESTART_REQUIRED" });
  });

  it("with restart: true restarts chromium, reopens the url in a new tab, binds that tab", async () => {
    warm.get("user-1").audio = undefined;
    const fresh = fakeTab("T9");
    bs.closeBrowserSession.mockImplementation(async () => {
      warm.set("user-1", { userId: "user-1", audio: { key: "abcd1234", devices: { sink: "s", mic: "m", source: "src" }, epoch: 1 } });
    });
    bs.openTab.mockImplementation(async () => { tabs.set("T9", fresh); return { ok: true, tab: fresh }; });
    const r = await startAudio("user-1", "T1", 24000, { restart: true });
    expect(bs.closeBrowserSession).toHaveBeenCalledWith("user-1");
    expect(bs.navigate).toHaveBeenCalledWith(fresh, "https://meet.example.com/abc-defg");
    expect(r).toMatchObject({ ok: true, session_id: "T9", restarted: true });
  });
});

describe("mic permission follows navigation", () => {
  it("re-grants on a main-frame navigation to a new origin, ignores subframes", async () => {
    await startAudio("user-1", "T1", 24000);
    browser.send.mockClear();
    const cdp = tabs.get("T1").cdp;
    cdp.emit("Page.frameNavigated", { frame: { id: "sub", parentId: "main", url: "https://ads.example.net/x" } });
    cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "https://app.example.com/wc/123" } });
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: "https://app.example.com",
    }));
    expect(browser.send).not.toHaveBeenCalledWith("Browser.setPermission", expect.objectContaining({ origin: "https://ads.example.net" }));
  });

  it("revokes every granted origin when the session ends", async () => {
    await startAudio("user-1", "T1", 24000);
    tabs.get("T1").cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "https://app.example.com/wc/123" } });
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledTimes(3));
    stopAudio("user-1", "T1");
    await vi.waitFor(() => {
      for (const origin of ["https://meet.example.com", "https://app.example.com"]) {
        expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
          permission: { name: "microphone" }, setting: "prompt", origin,
        });
      }
    });
  });
});

describe("lifecycle", () => {
  it("keeps the tab alive while audio runs", async () => {
    await startAudio("user-1", "T1", 24000);
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(bs.touchTab).toHaveBeenCalledWith("user-1", "T1");
  });

  it("stopAudio ends and reports; stop on an unbound tab returns zeros", async () => {
    await startAudio("user-1", "T1", 24000);
    expect(stopAudio("user-1", "T2")).toEqual({ played_ms: 0, duration_ms: 0 });
    const r = stopAudio("user-1", "T1");
    expect(r.played_ms).toBe(0);
    expect(getAudio("user-1")).toBeUndefined();
  });

  it("closing the bound tab ends with tab_closed; another tab does not", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    bs.browserEvents.emit("tab-closed", "user-1", "T2");
    expect(r.session.ended).toBeUndefined();
    bs.browserEvents.emit("tab-closed", "user-1", "T1");
    expect(r.session.ended).toBe("tab_closed");
    expect(getAudio("user-1")).toBeUndefined();
  });

  it("chromium exit ends with browser_exit", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    bs.browserEvents.emit("session-exit", "user-1");
    expect(r.session.ended).toBe("browser_exit");
  });

  it("daemon exit ends every session with audio_daemon_exit", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    pulseMock.emit("daemon-exit");
    expect(r.session.ended).toBe("audio_daemon_exit");
  });

  it("initBrowserAudio is idempotent (one end per event)", async () => {
    initBrowserAudio();
    initBrowserAudio();
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    const onEnd = vi.spyOn(r.session, "end");
    bs.browserEvents.emit("session-exit", "user-1");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-manager.test.ts`
Expected: FAIL, `Failed to resolve import "../src/audio/manager"`.

- [ ] **Step 3: Implement `src/audio/manager.ts`**

```ts
// One audio session per user, bound to one tab. Owns everything that ties an
// AudioSession to the browser: which tab, the mic permission on that tab's
// origin(s), keeping the tab from idling out, and ending the session when the
// tab, the chromium, or the PulseAudio daemon goes away.
import { config } from "../config";
import { pulse } from "./pulse";
import { AudioSession } from "./session";
import {
  browserEvents,
  getWarmSession,
  getTab,
  touchTab,
  browserClient,
  closeBrowserSession,
  openTab,
  navigate,
  type Tab,
} from "../auth/browser-session";

export const KEEPALIVE_MS = 10_000;
const REAP_INTERVAL_MS = 60_000;

export type StartAudioResult =
  | { ok: true; session: AudioSession; session_id: string; restarted: boolean }
  | {
      ok: false;
      error: "AUDIO_DISABLED" | "BROWSER_TAB_NOT_FOUND" | "AUDIO_BUSY" | "BROWSER_RESTART_REQUIRED";
      detail: string;
      session_id?: string;
    };

const sessions = new Map<string, AudioSession>();

export function getAudio(userId: string): AudioSession | undefined {
  return sessions.get(userId);
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function setMic(userId: string, origin: string, setting: "granted" | "prompt"): Promise<void> {
  const s = getWarmSession(userId);
  if (!s) return;
  const browser = await browserClient(s);
  await browser.send("Browser.setPermission", { permission: { name: "microphone" }, setting, origin });
}

async function tabUrl(userId: string, tabId: string): Promise<string> {
  const s = getWarmSession(userId);
  if (!s) return "";
  const browser = await browserClient(s);
  const r = (await browser.send("Target.getTargetInfo", { targetId: tabId })) as { targetInfo?: { url?: string } };
  return r.targetInfo?.url ?? "";
}

export async function startAudio(
  userId: string,
  tabId: string,
  rate: number,
  opts: { restart?: boolean } = {}
): Promise<StartAudioResult> {
  if (!config.BROWSER_AUDIO_ENABLED) {
    return { ok: false, error: "AUDIO_DISABLED", detail: "browser audio is off on this server (BROWSER_AUDIO_ENABLED)" };
  }
  const existing = sessions.get(userId);
  if (existing) {
    if (existing.tabId === tabId && existing.rate === rate) {
      return { ok: true, session: existing, session_id: tabId, restarted: false };
    }
    return {
      ok: false,
      error: "AUDIO_BUSY",
      detail: "audio is already running in another tab; call browser_audio_stop on it first",
      session_id: existing.tabId,
    };
  }
  if (!getTab(userId, tabId)) {
    return { ok: false, error: "BROWSER_TAB_NOT_FOUND", detail: "session_id is not an open tab of yours" };
  }

  // A daemon that died is restarted here, which bumps the epoch, which makes
  // the check below catch a chromium still wired to the dead one.
  await pulse.ensureDaemon();
  let restarted = false;
  let warm = getWarmSession(userId);
  if (!warm?.audio || warm.audio.epoch !== pulse.epoch) {
    if (!opts.restart) {
      return {
        ok: false,
        error: "BROWSER_RESTART_REQUIRED",
        detail:
          "this browser was started without audio devices. Call again with restart: true — the browser restarts, " +
          "logins survive, every open tab closes, and this tab's page reopens in a new tab whose session_id is returned",
      };
    }
    const url = await tabUrl(userId, tabId).catch(() => "");
    await closeBrowserSession(userId);
    const opened = await openTab(userId);
    if (!opened.ok) throw new Error(`browser restart failed: ${opened.error}`);
    if (originOf(url)) await navigate(opened.tab, url);
    tabId = opened.tab.id;
    restarted = true;
    warm = getWarmSession(userId);
    if (!warm?.audio) throw new Error("browser restarted without audio devices; check the server log for the PulseAudio error");
  }

  const tab = getTab(userId, tabId) as Tab;
  const granted = new Set<string>();
  const grant = (origin: string | null) => {
    if (!origin || granted.has(origin)) return;
    granted.add(origin);
    void setMic(userId, origin, "granted").catch(() => undefined);
  };

  const session = new AudioSession({
    userId,
    tabId,
    rate,
    devices: warm.audio.devices,
    io: pulse,
    maxMs: config.BROWSER_AUDIO_MAX_MINUTES * 60_000,
    onEnd: () => {
      if (sessions.get(userId) === session) sessions.delete(userId);
      clearInterval(keepAlive);
      offNav();
      for (const origin of granted) void setMic(userId, origin, "prompt").catch(() => undefined);
    },
  });

  // Meeting pages hop origins on join (a landing page, then the web client),
  // so the grant follows every main-frame navigation, not just the first page.
  const offNav = tab.cdp.on("Page.frameNavigated", (p) => {
    const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
    if (frame && !frame.parentId && frame.url) grant(originOf(frame.url));
  });
  const keepAlive = setInterval(() => touchTab(userId, tabId), KEEPALIVE_MS);
  keepAlive.unref?.();

  sessions.set(userId, session);
  session.start();
  grant(originOf(await tabUrl(userId, tabId).catch(() => "")));
  return { ok: true, session, session_id: tabId, restarted };
}

export function stopAudio(userId: string, tabId: string): { played_ms: number; duration_ms: number } {
  const s = sessions.get(userId);
  if (!s || s.tabId !== tabId) return { played_ms: 0, duration_ms: 0 };
  s.end("stopped");
  return { played_ms: s.totalPlayedMs, duration_ms: Date.now() - s.startedAt };
}

let initialized = false;

/** Wire lifecycle events and the orphan sweep. Called once from index.ts when the feature is on. */
export function initBrowserAudio(): void {
  if (initialized) return;
  initialized = true;
  browserEvents.on("tab-closed", (userId: string, tabId: string) => {
    const s = sessions.get(userId);
    if (s?.tabId === tabId) s.end("tab_closed");
  });
  browserEvents.on("session-exit", (userId: string) => {
    sessions.get(userId)?.end("browser_exit");
  });
  pulse.on("daemon-exit", () => {
    for (const s of [...sessions.values()]) s.end("audio_daemon_exit");
  });
  setInterval(() => { void pulse.reapOrphans().catch(() => undefined); }, REAP_INTERVAL_MS).unref?.();
}
```

`AudioSession` in Task 2 takes `io: AudioIO`; `PulseManager` satisfies it structurally (`capture(sink, rate)` and `playback(sink, rate)` return `ChildProcess`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_ENV=test npx vitest run tests/audio-manager.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p .
git add src/audio/manager.ts tests/audio-manager.test.ts
git commit -m "feat(audio): per-user audio manager with mic permission and lifecycle hooks"
```

---

### Task 6: `browser_audio_start` / `browser_audio_stop` tools

**Files:**
- Modify: `packages/server/src/plugins/internal/browser.ts` (imports and the `tools` array, after `browser_tabs`)
- Test: `packages/server/tests/browser-audio-tools.test.ts`

**Interfaces:**
- Consumes: `startAudio`, `stopAudio` (Task 5); `resolveTab`/`isNotFound` (existing, same file); `mintSessionKey` (`auth/cdp-bridge`); `config.SERVER_PUBLIC_URL`.
- Produces (MCP contract):
  - `browser_audio_start { session_id: string, sample_rate?: 16000|24000|48000, restart?: boolean }` →
    `{ session_id, restarted, format: "pcm_s16le", channels: 1, sample_rate, stream_url, clear_url, headers: { "X-Browser-Session": string } }`
    or `{ error, detail, session_id? }`
  - `browser_audio_stop { session_id }` → `{ played_ms, duration_ms }`

- [ ] **Step 1: Write the failing tests**

`tests/browser-audio-tools.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { startMock, stopMock, getTabMock, defaultTabMock, touchTabMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  getTabMock: vi.fn(),
  defaultTabMock: vi.fn(),
  touchTabMock: vi.fn(),
}));

vi.mock("../src/config", () => ({
  config: { SERVER_PUBLIC_URL: "https://wb.example.com", PORTAL_URL: "https://wb.example.com", CONNECT_TTL_SECONDS: 600 },
}));
vi.mock("../src/audio/manager", () => ({ startAudio: startMock, stopAudio: stopMock }));
vi.mock("../src/auth/browser-session", () => ({
  getTab: getTabMock,
  defaultTab: defaultTabMock,
  touchTab: touchTabMock,
  ensureSession: vi.fn(), touch: vi.fn(), openTab: vi.fn(), closeTab: vi.fn(), listTabs: vi.fn(),
  navigate: vi.fn(), screenshot: vi.fn(), click: vi.fn(), typeText: vi.fn(), pressKey: vi.fn(),
  scroll: vi.fn(), readText: vi.fn(), evaluate: vi.fn(), browserClient: vi.fn(), ensureDownloadRouting: vi.fn(),
}));
vi.mock("../src/auth/browser-downloads", () => ({ expectDownload: vi.fn(), awaitDownload: vi.fn() }));
vi.mock("../src/auth/browser-upload", () => ({ uploadWorkspaceFile: vi.fn(), BrowserUploadError: class extends Error {} }));
vi.mock("../src/auth/connect-token", () => ({ signConnectToken: vi.fn() }));
vi.mock("../src/auth/connections", () => ({ createPending: vi.fn() }));
vi.mock("../src/auth/cdp-bridge", () => ({
  mintSessionKey: vi.fn(() => "route-key"),
  verifySessionKey: vi.fn(() => false),
  SESSION_HEADER: "x-browser-session",
}));

import { browserPlugin } from "../src/plugins/internal/browser";

const tool = (n: string) => browserPlugin.tools.find((t) => t.name === n)! as any;
const TAB = { id: "T1", cdp: {} };

beforeEach(() => {
  getTabMock.mockImplementation((_u: string, id: string) => (id === "T1" ? TAB : undefined));
});

describe("browser_audio_start", () => {
  it("defaults to 24 kHz and returns absolute urls plus the routing header", async () => {
    startMock.mockResolvedValue({ ok: true, session: { rate: 24000 }, session_id: "T1", restarted: false });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(startMock).toHaveBeenCalledWith("user-1", "T1", 24000, { restart: false });
    expect(out).toEqual({
      session_id: "T1",
      restarted: false,
      format: "pcm_s16le",
      channels: 1,
      sample_rate: 24000,
      stream_url: "https://wb.example.com/api/browser/tabs/T1/audio/stream",
      clear_url: "https://wb.example.com/api/browser/tabs/T1/audio/clear",
      headers: { "X-Browser-Session": "route-key" },
    });
  });

  it("only accepts 16000, 24000, 48000", () => {
    const schema = tool("browser_audio_start").inputSchema;
    expect(schema.safeParse({ session_id: "T1", sample_rate: 44100 }).success).toBe(false);
    expect(schema.safeParse({ session_id: "T1", sample_rate: 16000 }).success).toBe(true);
  });

  it("returns the tab-not-found error without calling the manager", async () => {
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "nope" });
    expect(out.error).toBe("BROWSER_TAB_NOT_FOUND");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("passes manager refusals through", async () => {
    startMock.mockResolvedValue({ ok: false, error: "AUDIO_BUSY", detail: "busy", session_id: "T0" });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(out).toEqual({ error: "AUDIO_BUSY", detail: "busy", session_id: "T0" });
  });

  it("uses the new tab id in the urls after a restart", async () => {
    startMock.mockResolvedValue({ ok: true, session: { rate: 16000 }, session_id: "T9", restarted: true });
    const out = await tool("browser_audio_start").handler(
      { userId: "user-1" }, { session_id: "T1", sample_rate: 16000, restart: true }
    );
    expect(startMock).toHaveBeenCalledWith("user-1", "T1", 16000, { restart: true });
    expect(out.session_id).toBe("T9");
    expect(out.stream_url).toBe("https://wb.example.com/api/browser/tabs/T9/audio/stream");
  });
});

describe("browser_audio_stop", () => {
  it("stops audio on the tab", async () => {
    stopMock.mockReturnValue({ played_ms: 1200, duration_ms: 60000 });
    const out = await tool("browser_audio_stop").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(stopMock).toHaveBeenCalledWith("user-1", "T1");
    expect(out).toEqual({ played_ms: 1200, duration_ms: 60000 });
  });

  it("stops by raw id even when the tab is already gone", async () => {
    stopMock.mockReturnValue({ played_ms: 0, duration_ms: 0 });
    const out = await tool("browser_audio_stop").handler({ userId: "user-1" }, { session_id: "gone" });
    expect(stopMock).toHaveBeenCalledWith("user-1", "gone");
    expect(out).toEqual({ played_ms: 0, duration_ms: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/browser-audio-tools.test.ts`
Expected: FAIL, `Cannot read properties of undefined (reading 'handler')`.

- [ ] **Step 3: Add the tools**

In `browser.ts` imports, change the cdp-bridge import and add the manager:

```ts
import { verifySessionKey, mintSessionKey } from "../../auth/cdp-bridge";
import { startAudio, stopAudio } from "../../audio/manager";
```

Insert after the `browser_tabs` tool object:

```ts
  {
    name: "browser_audio_start",
    description:
      "Give this tab a live audio pipe so you can take part in a browser call (Zoom web, Slack huddle, Meet). " +
      "Call it after opening the meeting page, before joining. Returns stream_url: GET it as SSE for the call audio " +
      "(`audio` events: base64 PCM16 mono, 40 ms each) and POST one long chunked `Content-Type: audio/pcm` body to it " +
      "with your voice at the same rate. POST clear_url to stop your audio at once (barge-in); it returns played_ms. " +
      "Send `headers` on every one of those requests. One call per user at a time.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({
      session_id: z.string().describe(SESSION_ID_DESC),
      sample_rate: z
        .union([z.literal(16000), z.literal(24000), z.literal(48000)])
        .optional()
        .describe("PCM sample rate for both directions. Default 24000."),
      restart: z
        .boolean()
        .optional()
        .describe("Only after a BROWSER_RESTART_REQUIRED error: restart the browser with audio. Open tabs close; this page reopens in a new tab."),
    }),
    handler: async (ctx: any, args: any) => {
      const t = await resolveTab(ctx, args);
      if (isNotFound(t)) return t;
      const r = await startAudio(ctx.userId, t.id, args.sample_rate ?? 24000, { restart: args.restart === true });
      if (!r.ok) {
        return { error: r.error, detail: r.detail, ...(r.session_id ? { session_id: r.session_id } : {}) };
      }
      const base = `${config.SERVER_PUBLIC_URL}/api/browser/tabs/${encodeURIComponent(r.session_id)}/audio`;
      return {
        session_id: r.session_id,
        restarted: r.restarted,
        format: "pcm_s16le",
        channels: 1,
        sample_rate: r.session.rate,
        stream_url: `${base}/stream`,
        clear_url: `${base}/clear`,
        headers: { "X-Browser-Session": mintSessionKey(ctx.userId) },
      };
    },
  },
  {
    name: "browser_audio_stop",
    description: "End the audio pipe on this tab: the SSE stream gets `ended`, an open audio POST returns. The tab stays open.",
    integration: BROWSER_INTEGRATION_NAME,
    inputSchema: z.object({ session_id: z.string().describe(SESSION_ID_DESC) }),
    // No resolveTab: stopping must work after the tab is already gone.
    handler: async (ctx: any, args: any) => stopAudio(ctx.userId, args.session_id),
  },
```

- [ ] **Step 4: Run new and existing plugin tests**

Run: `NODE_ENV=test npx vitest run tests/browser-audio-tools.test.ts tests/browser-meta-tools.test.ts tests/tool-search.test.ts tests/mcp-browser-proxy.test.ts`
Expected: PASS. If `browser-meta-tools.test.ts` now fails importing the real `audio/manager` (it loads `../src/audio/pulse` and `config`), add `vi.mock("../src/audio/manager", () => ({ startAudio: vi.fn(), stopAudio: vi.fn() }))` to that file.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/internal/browser.ts tests/browser-audio-tools.test.ts tests/browser-meta-tools.test.ts
git commit -m "feat(audio): browser_audio_start and browser_audio_stop tools"
```

---

### Task 7: Audio HTTP routes (SSE out, uplink in, clear)

**Files:**
- Create: `packages/server/src/audio/routes.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/tests/audio-routes.test.ts`

**Interfaces:**
- Consumes: `getAudio` (Task 5); `AudioSession.subscribe/openUplink/clear` (Tasks 2–3); `resolveMcpUser` (`auth/oauth-server/resolve`); `forwardAudioStream` (Task 8; this task passes a stub so it can land first).
- Produces:
  ```ts
  export interface AudioRouteDeps {
    getAudio(userId: string): AudioSession | undefined;
    forward(opts: { userId: string; request: FastifyRequest; reply: FastifyReply }): Promise<boolean>;
  }
  export async function registerAudioRoutes(app: FastifyInstance, deps?: Partial<AudioRouteDeps>): Promise<void>;
  export const PING_MS = 15_000;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/audio-routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";

vi.mock("../src/config", () => ({
  config: { SERVER_PUBLIC_URL: "http://localhost:3000", SESSION_SECRET: "test-session-secret-32-chars-long!!" },
}));
// Routes get getAudio injected; keep the real manager (and the browser stack
// behind it) out of this suite.
vi.mock("../src/audio/manager", () => ({ getAudio: vi.fn() }));
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (h: Record<string, string>) => (h["x-workbench-api-key"] === "k1" ? "user-1" : null)),
}));

import { registerAudioRoutes } from "../src/audio/routes";
import { AudioSession, type AudioIO } from "../src/audio/session";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stdin = new PassThrough();
  p.stdin.resume();
  p.kill = vi.fn(() => true);
  return p;
}

let app: FastifyInstance;
let base: string;
let session: AudioSession;
let cap: any;
const forward = vi.fn(async () => false);

beforeEach(async () => {
  cap = fakeProc();
  const io: AudioIO = { capture: () => cap, playback: () => fakeProc() };
  session = new AudioSession({
    userId: "user-1", tabId: "T1", rate: 24000,
    devices: { sink: "s", mic: "m", source: "src" }, io, maxMs: 3_600_000,
  });
  session.start();
  app = Fastify();
  // The real boot carries OAuth's app-level form parser (api/oauth-routes.ts);
  // the audio scope must not inherit it.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );
  await registerAudioRoutes(app, { getAudio: (u) => (u === "user-1" && !session.ended ? session : undefined), forward });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  session.end("stopped");
  await app.close();
  forward.mockReset();
  forward.mockResolvedValue(false);
});

const H = { "x-workbench-api-key": "k1" };

async function readSse(res: Response, until: (events: Array<{ event: string; data: any }>) => boolean) {
  const events: Array<{ event: string; data: any }> = [];
  const reader = res.body!.getReader();
  let buf = "";
  while (!until(events)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : undefined });
    }
  }
  reader.cancel().catch(() => undefined);
  return events;
}

describe("auth and lookup", () => {
  it("401 without credentials", async () => {
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/clear`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("404 audio_not_started for a tab without audio, after trying the forward", async () => {
    const r = await fetch(`${base}/api/browser/tabs/T2/audio/clear`, { method: "POST", headers: H });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toBe("audio_not_started");
  });

  it("does not forward when this process owns a session on another tab", async () => {
    await fetch(`${base}/api/browser/tabs/T2/audio/clear`, { method: "POST", headers: H });
    expect(forward).not.toHaveBeenCalled();
  });

  it("hands off to the forward when there is no local session", async () => {
    session.end("stopped");
    forward.mockImplementation(async ({ reply }: any) => { reply.code(299).send({ forwarded: true }); return true; });
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(r.status).toBe(299);
  });
});

describe("GET stream (SSE)", () => {
  it("streams audio frames as base64 PCM and ends with ended", async () => {
    const res = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    setTimeout(() => {
      cap.stdout.emit("data", Buffer.alloc(1920, 1));
      setTimeout(() => session.end("stopped"), 20);
    }, 20);
    const events = await readSse(res, (e) => e.some((x) => x.event === "ended"));
    expect(events[0]).toMatchObject({ event: "audio", data: { seq: 0 } });
    expect(Buffer.from(events[0].data.pcm, "base64")).toHaveLength(1920);
    expect(events.at(-1)).toEqual({ event: "ended", data: { reason: "stopped" } });
  });

  it("a second reader replaces the first", async () => {
    const a = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    const aEvents = readSse(a, (e) => e.some((x) => x.event === "ended"));
    await new Promise((r) => setTimeout(r, 20));
    const b = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    expect(await aEvents).toEqual([{ event: "ended", data: { reason: "replaced" } }]);
    await b.body!.cancel();
  });
});

describe("POST stream (uplink)", () => {
  it("415 for a non-PCM content type", async () => {
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "application/x-www-form-urlencoded" }, body: "a=b",
    });
    expect(r.status).toBe(415);
  });

  it("queues the body, plays it out, answers 200 with played_ms", async () => {
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 100), // 100 ms
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ played_ms: 100 });
  });

  it("409 uplink_busy while another uplink is open", async () => {
    const held = session.openUplink();
    expect(typeof held).toBe("object");
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(10),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("uplink_busy");
  });

  it("answers at once with played_ms when the session ends mid-upload", async () => {
    const body = new PassThrough();
    const answered = new Promise<{ status: number; body: string }>((resolve) => {
      const req = httpRequest(`${base}/api/browser/tabs/T1/audio/stream`, {
        method: "POST", headers: { ...H, "content-type": "audio/pcm", "transfer-encoding": "chunked" },
      }, (res) => {
        let s = "";
        res.on("data", (c) => { s += c; });
        res.on("end", () => resolve({ status: res.statusCode!, body: s }));
      });
      req.on("error", () => undefined);
      body.pipe(req);
    });
    body.write(Buffer.alloc(48 * 1000));
    await new Promise((r) => setTimeout(r, 100));
    session.end("tab_closed");
    const r = await answered;
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).played_ms).toBeGreaterThan(0);
    body.destroy();
  });

  it("frees the uplink slot when the client aborts mid-upload", async () => {
    const req = httpRequest(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.write(Buffer.alloc(48 * 1000));
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    await vi.waitFor(() => expect(typeof session.openUplink()).toBe("object"), { timeout: 2000 });
    expect(session.ended).toBeUndefined();
  });
});

describe("POST clear", () => {
  it("returns played and cleared ms", async () => {
    const up = session.openUplink() as any;
    await up.write(Buffer.alloc(48 * 1000));
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cleared_ms).toBeGreaterThan(900);
    expect(body).toHaveProperty("played_ms");
  });
});
```

> The app-level form parser copies the one `registerOAuthRoutes` installs, so the raw-body scope is tested against the inherited-parser trap from `docs/findings/2026-09-15-workspace-inherited-form-parser.md`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-routes.test.ts`
Expected: FAIL, `Failed to resolve import "../src/audio/routes"`.

- [ ] **Step 3: Implement `src/audio/routes.ts`**

```ts
// HTTP face of the audio pipeline, keyed by tab:
//   GET  /api/browser/tabs/:session_id/audio/stream  → SSE, call audio out
//   POST /api/browser/tabs/:session_id/audio/stream  → chunked audio/pcm in, held open for the call
//   POST /api/browser/tabs/:session_id/audio/clear   → drop unplayed agent audio
// Spec: docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import { getAudio as defaultGetAudio } from "./manager";
import { forwardAudioStream } from "./stream-forward";
import type { AudioSession } from "./session";

export const PING_MS = 15_000;

export interface AudioRouteDeps {
  getAudio(userId: string): AudioSession | undefined;
  forward(opts: { userId: string; request: FastifyRequest; reply: FastifyReply }): Promise<boolean>;
}

type Params = { Params: { session_id: string } };

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

export async function registerAudioRoutes(app: FastifyInstance, overrides: Partial<AudioRouteDeps> = {}): Promise<void> {
  const deps: AudioRouteDeps = {
    getAudio: overrides.getAudio ?? defaultGetAudio,
    forward: overrides.forward ?? forwardAudioStream,
  };

  /**
   * The session for this tab, "handled" when the request was piped to the
   * owning pod, or null after a 404 has been sent. A session on *another* tab
   * means this process owns the user's chromium: answer here, never forward.
   */
  async function resolve(
    userId: string,
    request: FastifyRequest<Params>,
    reply: FastifyReply
  ): Promise<AudioSession | "handled" | null> {
    const s = deps.getAudio(userId);
    if (s && s.tabId === request.params.session_id) return s;
    if (!s && (await deps.forward({ userId, request, reply }))) return "handled";
    reply.code(404).send({
      error: "audio_not_started",
      detail: s
        ? `audio is running on session_id ${s.tabId}, not this one`
        : "call browser_audio_start for this session_id first",
    });
    return null;
  }

  await app.register(async (scope) => {
    // The uplink body is a raw PCM stream. Every parser this scope inherits —
    // the built-ins and any app-level one such as OAuth's form parser — would
    // otherwise win over the catch-all and leave nothing to stream
    // (docs/findings/2026-09-15-workspace-inherited-form-parser.md).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    const base = "/api/browser/tabs/:session_id/audio";

    scope.get<Params>(`${base}/stream`, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // A reader that cannot keep up loses audio frames (the seq gap tells it),
      // never control events, and never makes this process buffer without bound.
      let congested = false;
      res.on("drain", () => { congested = false; });
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* noop */ } }, PING_MS);
      ping.unref?.();

      const unsubscribe = s.subscribe((e) => {
        if (e.event === "audio" && congested) return;
        let ok = true;
        try { ok = res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); } catch { /* gone */ }
        if (!ok) congested = true;
        if (e.event === "ended") {
          clearInterval(ping);
          try { res.end(); } catch { /* noop */ }
        }
      });
      res.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return reply;
    });

    scope.post<Params>(`${base}/stream`, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const ct = String(request.headers["content-type"] ?? "");
      if (!ct.startsWith("audio/pcm")) {
        return reply.code(415).send({ error: "unsupported_media_type", detail: "send Content-Type: audio/pcm (raw s16le mono)" });
      }
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;
      const up = s.openUplink();
      if (up === "busy") return reply.code(409).send({ error: "uplink_busy", detail: "another audio POST is open for this call" });
      if (up === "ended") return reply.code(404).send({ error: "audio_not_started" });

      const pump = (async () => {
        for await (const chunk of request.raw) {
          await up.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
      })();
      const outcome = await Promise.race([
        pump.then(() => "eof" as const, () => "aborted" as const),
        up.sessionEnded.then(() => "ended" as const),
      ]);
      if (outcome === "aborted") {
        up.abort();
        return reply;
      }
      const result = await up.end();
      if (outcome === "ended") {
        // The agent is still writing into a call that is over: answer now and
        // let the connection close rather than read audio nobody will play.
        pump.catch(() => undefined);
        return reply.header("connection", "close").send(result);
      }
      return reply.send(result);
    });

    scope.post<Params>(`${base}/clear`, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;
      return reply.send(s.clear());
    });
  });
}
```

This task imports `./stream-forward`, which Task 8 creates. To keep this task green on its own, create the stub now:

`src/audio/stream-forward.ts` (stub; Task 8 replaces the body):

```ts
import type { FastifyReply, FastifyRequest } from "fastify";

export async function forwardAudioStream(_opts: {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  internalUrl?: string;
}): Promise<boolean> {
  return false;
}
```

- [ ] **Step 4: Register in `index.ts`**

Imports:

```ts
import { registerAudioRoutes } from "./audio/routes";
import { initBrowserAudio } from "./audio/manager";
import { pulse } from "./audio/pulse";
```

After `await registerWorkspaceRoutes(app);`:

```ts
  await registerAudioRoutes(app);
  if (config.BROWSER_AUDIO_ENABLED) initBrowserAudio();
```

In `registerShutdown`'s `shutdown`, before `await db.close();`:

```ts
    pulse.shutdown();
```

And after the two `process.once(...)` lines:

```ts
  // A crash must not leave a PulseAudio daemon behind holding the runtime dir.
  process.once("exit", () => pulse.shutdown());
```

- [ ] **Step 5: Run tests**

Run: `NODE_ENV=test npx vitest run tests/audio-routes.test.ts`
Expected: PASS (12 tests).

If "frees the uplink slot when the client aborts" hangs: for-await over `request.raw` must throw on a client abort (Node emits `aborted`/`error` → the iterator rejects). If your Node version ends the iterator cleanly instead, the outcome is `"eof"` with a non-empty queue that never drains to a reader. Then add `request.raw.on("aborted", () => up.abort())` before the pump.

- [ ] **Step 6: Typecheck, full suite, commit**

```bash
npx tsc --noEmit -p .
NODE_ENV=test npx vitest run
git add src/audio/routes.ts src/audio/stream-forward.ts src/index.ts tests/audio-routes.test.ts
git commit -m "feat(audio): SSE, uplink and clear routes for the browser audio pipe"
```

---

### Task 8: Streaming affinity forward

**Files:**
- Modify: `packages/server/src/audio/stream-forward.ts` (replace stub)
- Test: `packages/server/tests/audio-stream-forward.test.ts`

**Interfaces:**
- Consumes: `SESSION_HEADER`, `mintSessionKey`, `verifySessionKey` (`auth/cdp-bridge`); `config.INTERNAL_MCP_URL`.
- Produces: `forwardAudioStream({ userId, request, reply, internalUrl? }): Promise<boolean>`. True means the reply was taken over and piped from the owner. False means the caller should handle locally (no internal URL, the inbound key already verifies, or the hop failed before any response).

- [ ] **Step 1: Write the failing tests**

`tests/audio-stream-forward.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const cfg = vi.hoisted(() => ({
  SERVER_PUBLIC_URL: "http://localhost:3000",
  SESSION_SECRET: "test-session-secret-32-chars-long!!",
  INTERNAL_MCP_URL: undefined as string | undefined,
}));
vi.mock("../src/config", () => ({ config: cfg }));
vi.mock("../src/auth/oauth-server/resolve", () => ({
  resolveMcpUser: vi.fn(async (h: Record<string, string>) => (h["x-workbench-api-key"] === "k1" ? "user-1" : null)),
}));
vi.mock("../src/audio/manager", () => ({ getAudio: vi.fn() }));

import { registerAudioRoutes } from "../src/audio/routes";
import { forwardAudioStream } from "../src/audio/stream-forward";
import { AudioSession } from "../src/audio/session";
import { mintSessionKey } from "../src/auth/cdp-bridge";

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stdin = new PassThrough();
  p.stdin.resume();
  p.kill = vi.fn(() => true);
  return p;
}

// Two "pods" in one process: the owner holds the session, the entry pod holds
// none and forwards to the owner's origin.
let owner: FastifyInstance;
let entry: FastifyInstance;
let ownerUrl: string;
let entryUrl: string;
let session: AudioSession;
let cap: any;
const ownerHits = vi.fn();

async function listen(app: FastifyInstance) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

beforeEach(async () => {
  cap = fakeProc();
  session = new AudioSession({
    userId: "user-1", tabId: "T1", rate: 24000,
    devices: { sink: "s", mic: "m", source: "src" },
    io: { capture: () => cap, playback: () => fakeProc() }, maxMs: 3_600_000,
  });
  session.start();
  owner = Fastify();
  owner.addHook("onRequest", async (req) => { ownerHits(req.headers["x-browser-session"]); });
  await registerAudioRoutes(owner, { getAudio: () => (session.ended ? undefined : session), forward: async () => false });
  ownerUrl = await listen(owner);
  entry = Fastify();
  await registerAudioRoutes(entry, {
    getAudio: () => undefined,
    forward: (o) => forwardAudioStream({ ...o, internalUrl: `${ownerUrl}/mcp` }),
  });
  entryUrl = await listen(entry);
});

afterEach(async () => {
  session.end("stopped");
  await entry.close();
  await owner.close();
  ownerHits.mockReset();
});

const H = { "x-workbench-api-key": "k1" };

describe("forwardAudioStream", () => {
  it("pipes the SSE stream from the owner with the minted routing key", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/stream`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(ownerHits).toHaveBeenCalledWith(mintSessionKey("user-1"));
    setTimeout(() => cap.stdout.emit("data", Buffer.alloc(1920, 3)), 30);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: audio")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"seq":0');
    await reader.cancel();
  });

  it("pipes a chunked uplink body to the owner and relays the final 200", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 60),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 60 });
  });

  it("relays clear", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 0, cleared_ms: 0 });
  });

  it("handles locally when the inbound key already verifies (loop guard)", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, {
      method: "POST", headers: { ...H, "x-browser-session": mintSessionKey("user-1") },
    });
    expect(res.status).toBe(404);
    expect(ownerHits).not.toHaveBeenCalled();
  });

  it("forwards anyway when the inbound key belongs to someone else", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, {
      method: "POST", headers: { ...H, "x-browser-session": mintSessionKey("user-2") },
    });
    expect(res.status).toBe(200);
  });

  it("falls through to a local 404 when the owner is unreachable", async () => {
    await owner.close();
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(res.status).toBe(404);
  });

  it("returns false with no internal URL configured", async () => {
    const out = await forwardAudioStream({ userId: "user-1", request: { headers: {} } as any, reply: {} as any });
    expect(out).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `NODE_ENV=test npx vitest run tests/audio-stream-forward.test.ts`
Expected: FAIL. The stub returns false, so the forwarding tests get 404.

- [ ] **Step 3: Implement `src/audio/stream-forward.ts`**

```ts
// Streaming twin of auth/affinity-forward.ts for the audio endpoints. That one
// buffers a JSON body under a 30 s timeout; an SSE stream and an uplink held
// open for a whole call need both directions piped and no timeout at all.
// node:http rather than fetch: undici's default headersTimeout (300 s) would
// kill any uplink longer than five minutes, because its response headers only
// arrive when the call ends.
//
// Same rules as the buffered forward: the routing key is derived from the
// authenticated user, never taken from the client; an inbound key that
// verifies for this user means "you are the owner", so handle locally.
import http from "node:http";
import https from "node:https";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { SESSION_HEADER, mintSessionKey, verifySessionKey } from "../auth/cdp-bridge";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te", "trailer"]);
const PASS_THROUGH = ["authorization", "x-workbench-api-key", "content-type", "accept"];

export async function forwardAudioStream(opts: {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  internalUrl?: string;
}): Promise<boolean> {
  const { userId, request, reply } = opts;
  const internal = opts.internalUrl ?? config.INTERNAL_MCP_URL;
  if (!internal) return false;
  const inbound = request.headers[SESSION_HEADER];
  if (verifySessionKey(Array.isArray(inbound) ? inbound[0] : inbound, userId)) return false;

  const target = new URL(request.url, internal);
  const headers: Record<string, string> = { [SESSION_HEADER]: mintSessionKey(userId) };
  for (const h of PASS_THROUGH) {
    const v = request.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  const isPost = request.method === "POST";
  if (isPost) headers["transfer-encoding"] = "chunked";

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const mod = target.protocol === "https:" ? https : http;
    const upstream = mod.request(target, { method: request.method, headers }, (res) => {
      settled = true;
      reply.hijack();
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      }
      reply.raw.writeHead(res.statusCode ?? 502, out);
      res.pipe(reply.raw);
      resolve(true);
    });
    upstream.on("error", () => {
      if (!settled) {
        settled = true;
        resolve(false);
      } else {
        reply.raw.destroy();
      }
    });
    // Client gone (agent hung up, or the SSE reader went away): tear the hop down
    // so the owner sees the disconnect too and frees the reader / uplink slot.
    reply.raw.on("close", () => upstream.destroy());
    if (isPost) request.raw.pipe(upstream);
    else upstream.end();
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `NODE_ENV=test npx vitest run tests/audio-stream-forward.test.ts tests/audio-routes.test.ts`
Expected: PASS.

If "falls through to a local 404 when the owner is unreachable" fails with a hang on the POST: the entry has piped `request.raw` into a dead socket. `resolve(false)` still runs on the `error`, and the 404 is sent by `resolve()` in routes.ts. Confirm `request.raw.unpipe(upstream)` isn't needed on your Node version; add it in the error branch if it is.

- [ ] **Step 5: Commit**

```bash
git add src/audio/stream-forward.ts tests/audio-stream-forward.test.ts
git commit -m "feat(audio): streaming affinity forward for the audio endpoints"
```

---

### Task 9: Docker image and real-PulseAudio end-to-end test

**Files:**
- Modify: `Dockerfile` (runtime stage, before the playwright install)
- Create: `packages/server/tests/audio-e2e.test.ts`
- Create: `scripts/test-audio-e2e.sh`

**Interfaces:**
- Consumes: `PulseManager` (Task 1), `AudioSession` (Tasks 2–3), `spawnProfileChromium` with `env`/`extraArgs` (Task 4), `CdpClient` (`auth/browser-session`).
- Produces: a test that proves the real stack. It is the only check that headless Chromium actually plays to and records from these devices.

- [ ] **Step 1: Install PulseAudio in the image**

In `Dockerfile`, runtime stage, immediately before `# Cookie-auth capture spawns chromium …`:

```dockerfile
# Browser audio pipeline: a PulseAudio daemon (child of the server) gives each
# user's chromium a private virtual speaker and mic. Idle unless
# BROWSER_AUDIO_ENABLED is set. See docs/guides/browser-audio.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils \
 && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Write the e2e test**

`tests/audio-e2e.test.ts`:

```ts
/**
 * The audio pipeline against REAL PulseAudio and a REAL headless chromium.
 * Every other audio test drives fake streams; this is the one that would catch
 * chromium ignoring PULSE_SINK/PULSE_SOURCE, a remap source chromium will not
 * record from, or the autoplay policy muting the page.
 *
 * Runs only with TEST_AUDIO=1 on Linux with pulseaudio, pactl, parec, pacat
 * and playwright's chromium installed — use scripts/test-audio-e2e.sh.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENABLED = process.env.TEST_AUDIO === "1";

const { cfg } = vi.hoisted(() => ({
  cfg: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    BROWSER_PROFILES_DIR: "",
    BROWSER_DISK_CACHE_MB: 32,
    BROWSER_LAUNCH_TIMEOUT_MS: 20_000,
    DATABASE_URL: process.env.DATABASE_URL,
  },
}));
vi.mock("../src/config", () => ({ config: cfg }));

if (!ENABLED) {
  console.warn(
    "[audio-e2e] TEST_AUDIO not set — real PulseAudio + chromium test SKIPPED. " +
      "Run scripts/test-audio-e2e.sh to cover it."
  );
}

const PAGE = `<!doctype html><html><body><script>
const ctx = new AudioContext();
const osc = ctx.createOscillator();
osc.frequency.value = 440;
osc.connect(ctx.destination);
osc.start();
window.micFreq = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const c = new AudioContext();
  const an = c.createAnalyser();
  an.fftSize = 8192;
  c.createMediaStreamSource(stream).connect(an);
  await new Promise((r) => setTimeout(r, 1500));
  const d = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(d);
  let best = 1;
  for (let i = 2; i < d.length; i++) if (d[i] > d[best]) best = i;
  return best * c.sampleRate / an.fftSize;
};
</script></body></html>`;

/** Dominant frequency of PCM16 mono via zero crossings — enough for a pure tone. */
function toneHz(pcm: Buffer, rate: number): number {
  let crossings = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 2; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  return crossings / 2 / (pcm.length / 2 / rate);
}

function tone(hz: number, ms: number, rate: number): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  return b;
}

describe.skipIf(!ENABLED)("browser audio e2e", () => {
  let server: Server;
  const cleanups: Array<() => unknown> = [];
  afterAll(async () => { for (const c of cleanups.reverse()) await c(); });

  it("hears the page's 440 Hz tone and the page hears the agent's 880 Hz tone", async () => {
    cfg.BROWSER_PROFILES_DIR = mkdtempSync(join(tmpdir(), "wb-audio-e2e-"));
    const { PulseManager, deviceKey } = await import("../src/audio/pulse");
    const { AudioSession } = await import("../src/audio/session");
    const { spawnProfileChromium } = await import("../src/auth/profile-chromium");
    const { CdpClient } = await import("../src/auth/browser-session");

    server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const pageUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    cleanups.push(() => server.close());

    const pm = new PulseManager();
    cleanups.push(() => pm.shutdown());
    const key = deviceKey("e2e-user");
    const devices = await pm.createDevices(key);

    const chrome = await spawnProfileChromium("e2e-user", {
      env: { ...pm.clientEnv(), PULSE_SINK: devices.sink, PULSE_SOURCE: devices.source },
      extraArgs: ["--autoplay-policy=no-user-gesture-required"],
    });
    cleanups.push(() => chrome.proc.kill("SIGKILL"));

    const browser = new CdpClient(chrome.cdpBrowserWsUrl);
    await browser.ready;
    await browser.send("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: new URL(pageUrl).origin,
    });
    const page = new CdpClient(chrome.cdpPageWsUrl);
    await page.ready;
    await page.send("Page.navigate", { url: pageUrl });

    const rate = 24000;
    const session = new AudioSession({ userId: "e2e-user", tabId: chrome.cdpPageTargetId, rate, devices, io: pm, maxMs: 60_000 });
    session.start();
    cleanups.push(() => session.end("stopped"));

    // Downlink: collect ~1 s of call audio after a 500 ms settle.
    const frames: Buffer[] = [];
    session.subscribe((e) => { if (e.event === "audio") frames.push(Buffer.from(e.data.pcm, "base64")); });
    await new Promise((r) => setTimeout(r, 1500));
    const heard = Buffer.concat(frames.slice(-25)); // last 25 × 40 ms = 1 s
    expect(heard.length).toBeGreaterThan(rate); // got real samples
    expect(Math.abs(toneHz(heard, rate) - 440)).toBeLessThan(20);

    // Uplink: queue 4 s of 880 Hz, let the page measure its mic.
    const up = session.openUplink();
    if (typeof up === "string") throw new Error(up);
    await up.write(tone(880, 4000, rate));
    const r = (await page.send("Runtime.evaluate", { expression: "window.micFreq()", awaitPromise: true, returnByValue: true })) as {
      result: { value: number };
    };
    expect(Math.abs(r.result.value - 880)).toBeLessThan(30);

    // clear() reports progress and stops the tone.
    const c = session.clear();
    expect(c.played_ms).toBeGreaterThan(1000);
    expect(c.cleared_ms).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 3: Write `scripts/test-audio-e2e.sh`**

```bash
#!/usr/bin/env bash
# Run the real PulseAudio + chromium audio test in a Linux container. macOS has
# no PulseAudio, so this is the only way to run it from a laptop. CI can call
# it too.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -t \
  -v "$PWD":/src -w /src \
  -e TEST_AUDIO=1 -e NODE_ENV=test \
  node:26-bookworm-slim bash -c '
    set -e
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends python3 make g++ pulseaudio pulseaudio-utils >/dev/null
    npm ci --no-audit --no-fund
    cd packages/server
    npx playwright install --with-deps chromium >/dev/null
    npx vitest run tests/audio-e2e.test.ts
  '
```

```bash
chmod +x scripts/test-audio-e2e.sh
```

> `npm ci` inside the container rebuilds native modules (better-sqlite3) for Linux in the bind-mounted `node_modules`, which breaks the macOS host's copy. If the host's `node_modules` stops loading afterwards, run `npm ci` on the host again. If that is unacceptable, change the script to copy the repo into the container (`cp -r /src /work && cd /work`) before `npm ci`. Prefer the copy; decide when you first run it.

- [ ] **Step 4: Run it locally (skip path) and in the container (real path)**

Run: `NODE_ENV=test npx vitest run tests/audio-e2e.test.ts`
Expected: 1 skipped, with the SKIPPED warning printed.

Run (from repo root): `scripts/test-audio-e2e.sh`
Expected: 1 passed.

If it fails, record what you found in the finding doc (Task 10) before changing code. Likely culprits, in order:
1. Chromium ignores `PULSE_SINK` (headless audio output may be disabled). Try adding `--enable-features=AudioServiceOutOfProcess` or dropping to `--headless=old` in `extraArgs` only. The page heard nothing means a 0 Hz/noise result on the downlink assert.
2. Chromium refuses a remap source as input. Switch the source to `module-virtual-source` (`source_name=… master=<mic>.monitor`) in `pulse.ts`, updating Task 1's test expectation to match.
3. `pulseaudio` refuses to run as root without `--system`. Add `--system=false` or run with `--disallow-module-loading=no`. The stderr tail is in the `pulseaudio did not start` error.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile tests/audio-e2e.test.ts scripts/test-audio-e2e.sh
git commit -m "test(audio): real PulseAudio + chromium end-to-end, pulseaudio in the image"
```

---

### Task 10: Docs, finding, and release prep

**Files:**
- Create: `docs/findings/2026-10-07-browser-audio-pipeline.md`
- Create: `docs/site/_content/guides/browser-audio.md`
- Modify: `docs/site/nav.json` (Guides, after `guides/browser-sessions`)
- Modify: `docs/site/_content/integrations/browser.md` (tool list)
- Modify: `CLAUDE.md` (Findings Index)

**Interfaces:**
- Consumes: everything above. Docs describe the shipped contract only.

- [ ] **Step 1: Write the finding**

`docs/findings/2026-10-07-browser-audio-pipeline.md`. Fill every section with what was actually observed in Task 9, not what the spec predicted:

```markdown
# Browser audio pipeline: PulseAudio devices per user chromium

**Date:** 2026-10-07

## What we needed

An agent running a full-duplex voice model has to hear and speak in a browser
call (Zoom web, Slack huddle, Meet) driven through the built-in browser.
Headless chromium has no audio devices.

## What we found

- Hooking audio inside the page (getUserMedia override, AudioContext taps,
  WebRTC track listeners) breaks per app: Zoom web mixes in WASM/worklets,
  huddles run in iframes, and a patched getUserMedia is detectable. OS-level
  virtual devices are the only app-agnostic layer.
- Chromium reads `PULSE_SINK`/`PULSE_SOURCE` once at spawn, so devices must
  exist before chromium starts; an already-running chromium needs a restart.
- A `module-pipe-source` fixes its rate at load time and stalls rather than
  producing silence on underrun. A null sink plus a remap source over its
  monitor lets `pacat --rate` resample and keeps the mic live between turns.
- Pacing agent audio in the server (one 20 ms frame per tick into `pacat
  --latency-msec=20`) keeps the queue in-process, so `clear` is instant and
  `played_ms` is exact to about ±40 ms — what `conversation.item.truncate` needs.
- `<record the e2e result here: which flags were needed, measured downlink/uplink
  frequencies, whether pulseaudio ran as root unmodified>`
- The buffered affinity forward cannot carry an SSE stream or an uplink held
  open for a call; a `node:http` pipe can, and fetch cannot (undici's 300 s
  headersTimeout fires before an uplink's response headers arrive).

## What changed

PulseAudio daemon per server process (`audio/pulse.ts`), `AudioSession`
(`audio/session.ts`), per-user manager with mic permission that follows
main-frame navigation (`audio/manager.ts`), routes keyed by tab
(`audio/routes.ts`), streaming forward (`audio/stream-forward.ts`),
`browser_audio_start`/`browser_audio_stop`. Behind `BROWSER_AUDIO_ENABLED`.

## Limits

One call per user. Audio from the user's other tabs leaks into the stream. A
pod rollout ends live calls. Recording/consent is the operator's
responsibility.
```

Replace the angle-bracket line with the observed facts before committing. It is the one line the template cannot know in advance.

- [ ] **Step 2: Write the guide**

`docs/site/_content/guides/browser-audio.md`:

````markdown
# Browser audio

Let an agent join a browser-based call — Zoom web client, Slack huddle, Google
Meet, anything that runs in a tab — and talk in it. Workbench is the pipe: raw
PCM out of the call, raw PCM into the call's microphone. Speech recognition,
turn-taking and voice come from your agent (a full-duplex realtime voice model
works best).

## Enable it

```bash
BROWSER_AUDIO_ENABLED=true
BROWSER_AUDIO_MAX_MINUTES=120   # hard cap per call
```

The Docker image ships PulseAudio; nothing runs until the flag is on. A browser
that was already open before you enabled it restarts on the first
`browser_audio_start` (pass `restart: true` when asked).

## Flow

1. `browser_start` → `session_id`, `browser_navigate` to the meeting link.
2. `browser_audio_start { session_id, sample_rate: 24000 }` → `stream_url`,
   `clear_url`, `headers`.
3. Open the downlink: `GET stream_url` with `headers` (SSE).
4. Open the uplink: `POST stream_url` with `headers`,
   `Content-Type: audio/pcm`, chunked, and keep it open.
5. Click through the meeting's join flow (`browser_click`, `browser_screenshot`);
   choose "computer audio" when asked.
6. Pipe: every SSE `audio` frame → your model's input; every model audio delta →
   write into the uplink body.
7. When your model is interrupted: `POST clear_url` → `{ played_ms, cleared_ms }`.
   `audio_end_ms = played_ms − <ms of audio you had sent before this response
   started>` is what a realtime API's truncate call needs.
8. Leave the meeting, then `browser_audio_stop { session_id }`.

## Wire format

PCM signed 16-bit little-endian, mono, at `sample_rate` (16000, 24000 or
48000; default 24000) in both directions.

SSE events:

| event | data |
|---|---|
| `audio` | `{ "seq": 412, "pcm": "<base64>" }`, 40 ms each; a `seq` gap means frames were dropped because you read too slowly |
| `playback` | `{ "played_ms", "buffered_ms" }` every 200 ms while your audio is queued, and once when it drains |
| `ended` | `{ "reason" }` — `stopped`, `tab_closed`, `browser_exit`, `replaced`, `max_duration`, `capture_failed`, `playback_failed`, `audio_daemon_exit` |

Opening a second `GET` replaces the first (`ended{replaced}`), so reconnecting
is safe. A second concurrent `POST` gets `409 uplink_busy`. The uplink accepts
audio faster than real time and queues up to 120 s; past that it stops reading
your body until audio plays. Closing the body plays out the queue, then the
response is `200 { "played_ms" }`.

## Routing in a cluster

Send the returned `headers` (`X-Browser-Session`) on all three requests so the
mesh routes them to the pod running your browser. If a request lands elsewhere
the server pipes it to the right pod itself (needs `INTERNAL_MCP_URL`), at the
cost of an extra hop. Same operator rules as
[browser sessions](browser-sessions.md): consistent hash on that header, to pod
endpoints, `CLUSTER_ENABLED` off.

## Limits

- One call per user at a time (`AUDIO_BUSY` names the tab that has it).
- Audio from your other tabs is mixed into the stream.
- A pod restart ends the call (`ended{browser_exit}`); rejoin.
- Tell the people in the call they are talking to an agent. Recording and
  consent rules where you operate are yours to follow.
````

- [ ] **Step 3: Nav, integration page, findings index**

`docs/site/nav.json`, after the `guides/browser-sessions` entry:

```json
            {
              "path": "guides/browser-audio",
              "label": "Browser audio"
            },
```

`docs/site/_content/integrations/browser.md`: add to its tool list, in the file's existing list format:

```markdown
- `browser_audio_start`: give a tab a live audio pipe for a browser call (SSE out, chunked PCM in). See [Browser audio](../guides/browser-audio.md).
- `browser_audio_stop`: end the audio pipe on a tab.
```

`CLAUDE.md`, append to the Findings Index:

```markdown
- [2026-10-07 browser audio pipeline](docs/findings/2026-10-07-browser-audio-pipeline.md) — agent joins browser calls through a per-user PulseAudio null sink (speaker) + remap source over a second null sink (mic), set via `PULSE_SINK`/`PULSE_SOURCE` at chromium spawn; in-page audio hooks rejected as per-app brittle; server-side 20 ms pacing into `pacat` keeps the queue in-process so `clear` is instant and `played_ms` feeds `conversation.item.truncate`; SSE/uplink need a `node:http` streaming forward (undici's 300 s headersTimeout kills a call-long uplink)
```

- [ ] **Step 4: Build docs (link check) and run the whole suite**

Run (repo root): `node docs/site/build.mjs`
Expected: builds with no broken-link errors.

Run (`packages/server`): `npx tsc --noEmit -p . && NODE_ENV=test npx vitest run`
Expected: all pass; `audio-e2e` skipped.

- [ ] **Step 5: Hygiene check and commit**

```bash
git add -A docs CLAUDE.md
git diff --cached | grep -inIE '@(icloud|gmail)\.com' || true   # must print nothing
git commit -m "docs(audio): browser audio guide, finding, nav"
```

- [ ] **Step 6: Release**

This touches the Docker image and adds a proxy path, so it ships as an RC. Invoke the `release-prep` skill (`.claude/skills/release-prep/SKILL.md`). It picks the version, writes `docs/releases/vX.Y.Z.md` (Features: browser audio pipeline, explaining the *why* and linking the finding and guide), and tags `vX.Y.Z-rc.1`. Do not tag by hand.

---

## Self-Review Notes

- **Spec coverage:**
  - Decision (pipe, PulseAudio, one call per user, tab binding, duplex) → Tasks 1–7.
  - Architecture units → Tasks 1, 2–3, 5, 7, 8.
  - Devices from spawn plus restart → Tasks 4 and 5.
  - API (tools) → Task 6.
  - Routing / streaming forward → Task 8.
  - SSE / uplink / clear → Tasks 2, 3, 7.
  - Lifecycle (daemon, devices, keep-alive, cap, end paths) → Tasks 1, 2, 4, 5.
  - Failure handling → Tasks 2, 3, 7, 8.
  - Security (auth, scoped lookup, permission grant/revoke, no audio logs, raw parser) → Tasks 5, 7.
  - Config → Task 1.
  - Testing incl. e2e → every task plus Task 9.
  - Release → Tasks 9 and 10.
- **Spec deviations** are listed under Global Constraints.
- **Known judgment calls the executor may hit:** the bind-mount vs copy choice in `scripts/test-audio-e2e.sh`, and the fallback device/flag choices if the e2e fails. Both are spelled out in their steps.
