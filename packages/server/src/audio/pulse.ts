// The only code that talks to PulseAudio. One daemon per user gives each
// user's chromium a private speaker and mic for browser calls, so an agent
// can participate. Cross-tenant isolation: enumerateDevices() on one user's
// daemon cannot discover another user's sink/mic names.
//
// Per user, not per process: each PulseManager instance is tied to one user's
// unique key, ensuring audio device isolation across users.
import { spawn as nodeSpawn, execFile, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
 * 16 hex chars naming one user's devices. Device names show up in `pactl`
 * output and process listings, so they carry a keyed hash, never the user id.
 */
export function deviceKey(userId: string): string {
  return createHmac("sha256", config.SESSION_SECRET)
    .update(`browser-audio:${userId}`)
    .digest("hex")
    .slice(0, 16);
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

const KEY_RE = /^(?:sink_name|source_name)=wb_(?:sink|mic|src)_([0-9a-f]{16})$/;

export interface PulseManagerOpts {
  key: string;
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
  readonly key: string;
  readonly runtimeDir?: string;
  private daemon?: ChildProcess;
  private starting?: Promise<void>;
  private creatingDevices = new Map<string, Promise<PulseDevices>>();
  private actualRuntimeDir?: string;
  private daemonReady = false;
  private opts: PulseManagerOpts;

  constructor(opts: PulseManagerOpts) {
    super();
    this.key = opts.key;
    this.runtimeDir = opts.runtimeDir;
    this.opts = opts;
    // If runtimeDir is provided, set it immediately for testing
    if (opts.runtimeDir) {
      this.actualRuntimeDir = opts.runtimeDir;
    }
  }

  private get socket(): string {
    if (!this.actualRuntimeDir) throw new Error("PulseManager daemon has not started");
    return join(this.actualRuntimeDir, "native");
  }

  /** Env every client (chromium, parec, pacat, pactl) needs to reach this daemon. */
  clientEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PULSE_SERVER: `unix:${this.socket}` };
  }

  private helperEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.actualRuntimeDir,
      XDG_RUNTIME_DIR: this.actualRuntimeDir,
      PULSE_RUNTIME_PATH: this.actualRuntimeDir,
      PULSE_SERVER: `unix:${this.socket}`,
    };
    if (process.env.LANG) env.LANG = process.env.LANG;
    return env;
  }

  ensureDaemon(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.daemon && this.daemon.exitCode === null && this.daemonReady) return Promise.resolve();
    this.starting = this.startDaemon().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startDaemon(): Promise<void> {
    // Only create new runtime dir if not provided in opts
    if (!this.runtimeDir) {
      this.actualRuntimeDir = mkdtempSync(join(tmpdir(), "wb-pulse-"));
    }
    mkdirSync(this.actualRuntimeDir!, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      HOME: this.actualRuntimeDir,
      XDG_RUNTIME_DIR: this.actualRuntimeDir,
      PULSE_RUNTIME_PATH: this.actualRuntimeDir,
    };
    if (process.env.LANG) env.LANG = process.env.LANG;
    if (process.env.PATH) env.PATH = process.env.PATH;

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

    let spawnError: Error | undefined;
    let wasReady = false;

    proc.on("error", (err: Error) => {
      spawnError = err;
    });

    proc.on("exit", () => {
      if (this.daemon !== proc) return;
      this.daemon = undefined;
      this.daemonReady = false;
      if (wasReady) this.emit("daemon-exit");
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 5_000);
    for (;;) {
      if (spawnError) {
        this.daemon = undefined;
        throw new Error(`pulseaudio did not start: ${spawnError.message}`.trim());
      }
      try {
        await this.pactl(["info"]);
        break;
      } catch (e) {
        if (proc.exitCode !== null || Date.now() > deadline) {
          this.daemon = undefined;
          try { proc.kill("SIGKILL"); } catch { /* noop */ }
          throw new Error(`pulseaudio did not start: ${(e as Error).message} ${stderrTail.trim()}`.trim());
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    wasReady = true;
    this.daemonReady = true;
    this.epoch += 1;
  }

  private pactl(args: string[]): Promise<string> {
    return (this.opts.exec ?? defaultExec)("pactl", args, this.helperEnv());
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
    const inFlight = this.creatingDevices.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
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
      return d;
    })().finally(() => {
      this.creatingDevices.delete(key);
    });

    this.creatingDevices.set(key, promise);
    return promise;
  }

  async destroyDevices(key: string): Promise<void> {
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

  capture(sink: string, rate: number): ChildProcess {
    const proc = (this.opts.spawn ?? defaultSpawn)(
      "parec",
      [`--device=${sink}.monitor`, "--format=s16le", `--rate=${rate}`, "--channels=1", "--raw", "--latency-msec=20"],
      this.helperEnv()
    );
    let realExitSeen = false;
    proc.once("exit", () => {
      realExitSeen = true;
    });
    proc.on("error", (err) => {
      if (!realExitSeen) {
        proc.emit("exit", null, null);
      }
    });
    return proc;
  }

  playback(sink: string, rate: number): ChildProcess {
    const proc = (this.opts.spawn ?? defaultSpawn)(
      "pacat",
      ["--playback", `--device=${sink}`, "--format=s16le", `--rate=${rate}`, "--channels=1", "--raw", "--latency-msec=20"],
      this.helperEnv()
    );
    let realExitSeen = false;
    proc.once("exit", () => {
      realExitSeen = true;
    });
    proc.on("error", (err) => {
      if (!realExitSeen) {
        proc.emit("exit", null, null);
      }
    });
    return proc;
  }

  shutdown(): void {
    const d = this.daemon;
    this.daemon = undefined;
    this.daemonReady = false;
    try { d?.kill("SIGTERM"); } catch { /* noop */ }
    if (this.actualRuntimeDir && !this.runtimeDir) {
      try { rmSync(this.actualRuntimeDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
}

const managers = new Map<string, PulseManager>();

export function pulseFor(key: string): PulseManager {
  const existing = managers.get(key);
  if (existing) return existing;
  const pm = new PulseManager({ key });
  managers.set(key, pm);
  return pm;
}

export function releasePulse(key: string): void {
  const pm = managers.get(key);
  if (pm) {
    pm.shutdown();
    managers.delete(key);
  }
}

export function shutdownAllPulse(): void {
  for (const pm of managers.values()) {
    pm.shutdown();
  }
  managers.clear();
}
