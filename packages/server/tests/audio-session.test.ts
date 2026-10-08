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
