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
  | "audio_daemon_exit"
  | "idle";

export type AudioEvent =
  | { event: "audio"; data: { seq: number; pcm: string } }
  | { event: "playback"; data: { played_ms: number; buffered_ms: number } }
  | { event: "ended"; data: { reason: EndReason } };

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
  /** Monotonic clock for pacing (defaults to performance.now). */
  now?: () => number;
}

export interface Uplink {
  /** Queue agent PCM. Resolves once the queue is under QUEUE_CAP_MS — the caller awaits it before reading more of the request body, which is the backpressure. */
  write(chunk: Buffer): Promise<void>;
  /** The agent finished sending: resolves when the queue has played out, or at once if the session ended. */
  end(): Promise<{ played_ms: number }>;
  /** The agent went away: drop what is queued and free the slot. */
  abort(): void;
  readonly sessionEnded: Promise<EndReason>;
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
  private now: () => number;

  constructor(private readonly opts: AudioSessionOpts) {
    this.userId = opts.userId;
    this.tabId = opts.tabId;
    this.rate = opts.rate;
    this.now = opts.now ?? (() => performance.now());
    this.whenEnded = new Promise((r) => { this.resolveEnded = r; });
  }

  /** PCM16 mono bytes per millisecond at this session's rate. */
  protected get bytesPerMs(): number {
    return (this.rate * 2) / 1000;
  }

  /** An SSE reader or an uplink is attached: someone is on the call, so the tab counts as in use. */
  get attached(): boolean {
    return !this.ended && (this.subscriber !== undefined || this.uplink !== undefined);
  }

  get totalPlayedMs(): number {
    return Math.round(this.totalPlayedBytes / this.bytesPerMs);
  }

  start(): void {
    const { io, devices, rate } = this.opts;
    this.capture = io.capture(devices.sink, rate);
    this.capture.stdout?.on("data", (c: Buffer) => this.onCapture(c));
    this.capture.stdout?.on("error", () => this.end("capture_failed"));
    this.capture.on("exit", () => { if (!this.ended) this.end("capture_failed"); });

    this.playback = io.playback(devices.mic, rate);
    this.playback.stdin?.on("error", () => { /* the exit handler reports it */ });
    this.playback.on("exit", () => { if (!this.ended) this.end("playback_failed"); });

    this.pacerStart = this.now();
    this.pacer = setInterval(() => this.tick(), TICK_MS);
    this.pacer.unref?.();

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
   * Attach the one SSE reader. A second concurrent reader is refused ("busy"):
   * the stream URL is a bearer capability, and a second consumer must not be
   * able to take a call away from the first. A reader that has gone away has
   * unsubscribed, so a reconnect after a network blip is accepted.
   */
  subscribe(sub: Subscriber): (() => void) | "busy" {
    if (this.ended) {
      sub({ event: "ended", data: { reason: this.ended } });
      return () => undefined;
    }
    if (this.subscriber) return "busy";
    this.subscriber = sub;
    return () => { if (this.subscriber === sub) this.subscriber = undefined; };
  }

  protected emit(e: AudioEvent): void {
    this.subscriber?.(e);
  }

  end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = reason;
    if (this.maxTimer) clearTimeout(this.maxTimer);
    try { this.capture?.kill("SIGTERM"); } catch { /* noop */ }
    try { this.playback?.kill("SIGTERM"); } catch { /* noop */ }
    try { this.onEnded(); } catch { /* noop */ }
    try {
      const sub = this.subscriber;
      this.subscriber = undefined;
      sub?.({ event: "ended", data: { reason } });
    } catch { /* noop */ }
    this.resolveEnded(reason);
    try { this.opts.onEnd?.(reason); } catch { /* noop */ }
  }

  protected onEnded(): void {
    if (this.pacer) clearInterval(this.pacer);
    this.dropQueue();
    this.uplink = undefined;
    this.wake(this.drainWaiters);
  }

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
    const elapsedTicks = Math.floor((this.now() - this.pacerStart) / TICK_MS);
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
    // Take only whole samples: limit to even bytes to avoid mid-sample breaks.
    const maxBytes = Math.min(this.queuedBytes & ~1, n);
    let off = 0;
    while (off < maxBytes && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, maxBytes - off);
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
    // Treat lone trailing byte as drained if transitioning from buffered to empty/stray.
    // Only drop if we have drain waiters (end() waiting) or after becoming too small to fill samples.
    const isStray = this.queuedBytes < 2;
    if (isStray && this.wasBuffered && this.drainWaiters.length > 0) {
      if (this.queuedBytes === 1) this.dropQueue();
    }
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
        // C2: drop a lone trailing byte to prevent permanent stall
        if (mine() && this.queuedBytes === 1) {
          this.dropQueue();
        }
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
}
