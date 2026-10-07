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
