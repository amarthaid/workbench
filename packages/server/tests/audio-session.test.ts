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

function makeSession(over: Partial<{ rate: number; maxMs: number; onEnd: any; now?: () => number }> = {}) {
  const s = new AudioSession({
    userId: "user-1",
    tabId: "T1",
    rate: over.rate ?? 24000,
    devices: DEVICES,
    io,
    maxMs: over.maxMs ?? 60 * 60_000,
    onEnd: over.onEnd,
    now: over.now,
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

  it("a subscriber that throws on ended still results in whenEnded resolving and onEnd being called once", async () => {
    const onEnd = vi.fn();
    const s = makeSession({ onEnd });
    s.subscribe(() => {
      throw new Error("subscriber error");
    });
    s.end("stopped");
    expect(s.ended).toBe("stopped");
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith("stopped");
    await expect(s.whenEnded).resolves.toBe("stopped");
  });

  it("processes are killed even if onEnded throws", () => {
    class FailingSession extends AudioSession {
      protected onEnded(): void {
        throw new Error("onEnded error");
      }
    }
    const s = new FailingSession({
      userId: "user-1",
      tabId: "T1",
      rate: 24000,
      devices: DEVICES,
      io,
      maxMs: 60 * 60_000,
    });
    s.start();
    s.end("stopped");
    expect(cap.kill).toHaveBeenCalled();
    expect(play.kill).toHaveBeenCalled();
    expect(s.ended).toBe("stopped");
  });
});

describe("AudioSession uplink pacing", () => {
  // 24 kHz: 20 ms tick = 960 bytes, 1 ms = 48 bytes.
  it("preserves sample boundaries: takes only whole samples, never odd bytes", async () => {
    // C1: write 301 bytes (150 samples + 1 stray byte) → tick → write rest → tick.
    // If takeFrame() took odd bytes, later samples shift by 1 byte, breaking alignment.
    const s = makeSession();
    const up = s.openUplink() as any;
    const pcm = Buffer.alloc(960);
    for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
    await up.write(pcm.subarray(0, 301)); // 150 samples + 1 stray byte
    vi.advanceTimersByTime(20); // tick drains 300 bytes (150 samples), leaves 1 byte
    await up.write(pcm.subarray(301)); // now have 1 + 659 = 660 bytes total
    vi.advanceTimersByTime(20); // tick drains all 660 bytes
    // Verify the 660 bytes we output have correct sample alignment (all 1000, not misaligned noise).
    // The 660 bytes come from: 1 stray byte + 659 from second write = 330 samples total.
    const out: Buffer = play.written.at(-1);
    for (let i = 0; i < 660; i += 2) { // check the 330 samples we output
      expect(out.readInt16LE(i)).toBe(1000);
    }
  });

  it("resolves end() even with a lone trailing byte in the queue", async () => {
    // C2: write 961 bytes (480.5 samples) → ticks drain 960 bytes (480 samples).
    // Lone byte must not block drain.
    const s = makeSession();
    const up = s.openUplink() as any;
    await up.write(Buffer.alloc(961, 0));
    vi.advanceTimersByTime(20);
    expect(play.written).toHaveLength(1); // first tick drained 960 bytes
    const r = up.end();
    await expect(r).resolves.toEqual({ played_ms: 20 });
  });

  it("clock skew: backwards jump does not stall later ticks", async () => {
    // I1: inject a controllable clock, jump it backwards, verify frames still flow when time moves forward.
    let t = 0;
    const s = makeSession({ now: () => t });
    t += 40; // advance to 40ms (2 ticks due)
    vi.advanceTimersByTime(20);
    const after1 = play.written.length; // should be 2 frames
    t -= 20; // jump backwards 20ms (clock correction: now at 20ms)
    vi.advanceTimersByTime(20);
    expect(play.written.length).toBe(after1); // no extra frames (due <= 0)
    t += 60; // time moves forward again: now at 80ms (4 ticks)
    vi.advanceTimersByTime(20);
    // Caught up with at most MAX_CATCHUP_TICKS (5) new frames
    expect(play.written.length - after1).toBeLessThanOrEqual(5 + 1);
    expect(play.written.length).toBeGreaterThan(after1); // but at least some new frames
  });

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
    let t = 0;
    const s = makeSession({ now: () => t });
    t += 20;
    vi.advanceTimersByTime(20);
    const before = play.written.length;
    // Simulate a 1 s stall: the clock jumps without the interval firing.
    t += 1_000;
    vi.advanceTimersByTime(20);
    // Should write at most 5 + 1 frames (5 catchup + 1 for the current tick).
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

