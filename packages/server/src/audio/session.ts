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
