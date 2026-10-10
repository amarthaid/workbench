import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request as httpRequest } from "node:http";

vi.mock("../src/config", () => ({
  config: { SERVER_PUBLIC_URL: "http://localhost:3000", SESSION_SECRET: "test-session-secret-32-chars-long!!" },
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

// Synthetic capability; the routes only ever see it through the injected lookup.
const CAP = "capAAAAAAAAAAAAAAAAAAA";
const UNKNOWN = "capZZZZZZZZZZZZZZZZZZZ";
const SESSION_KEY = "K".repeat(43);

let app: FastifyInstance;
let base: string;
let session: AudioSession;
let cap: any;
const forward = vi.fn(async (_o?: any) => false);
const lookup = vi.fn((c: string) => (c === CAP && !session.ended ? session : undefined));

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
  await registerAudioRoutes(app, { lookup, forward });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  session.end("stopped");
  await app.close();
  forward.mockReset();
  forward.mockResolvedValue(false);
  lookup.mockClear();
});

const url = (c: string, leaf: "stream" | "clear") => `${base}/api/browser/audio/${c}/${leaf}`;
const STREAM = () => url(CAP, "stream");
const CLEAR = () => url(CAP, "clear");

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

/** Open an SSE reader over node:http so the test controls exactly when the socket goes away. */
async function openRawReader(): Promise<{ status: number; close: () => void }> {
  const req = httpRequest(STREAM());
  const gotHeaders = new Promise<import("node:http").IncomingMessage>((r) => req.on("response", r));
  req.on("error", () => undefined);
  req.end();
  const res = await gotHeaders;
  res.resume();
  return { status: res.statusCode!, close: () => { res.destroy(); req.destroy(); } };
}

describe("capability lookup", () => {
  it("serves the SSE stream with only X-Browser-Session and no Authorization", async () => {
    const res = await fetch(STREAM(), { headers: { "x-browser-session": SESSION_KEY } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(lookup).toHaveBeenCalledWith(CAP);
    await res.body!.cancel();
  });

  it("ignores a garbage Authorization header", async () => {
    const res = await fetch(STREAM(), { headers: { authorization: "Bearer not-a-real-token" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body!.cancel();
    const r = await fetch(CLEAR(), { method: "POST", headers: { authorization: "Basic Z2FyYmFnZQ==" } });
    expect(r.status).toBe(200);
  });

  it("404 audio_not_found for an unknown capability, after trying the forward; no redirect, no echo", async () => {
    for (const [method, leaf] of [["GET", "stream"], ["POST", "clear"]] as const) {
      const r = await fetch(url(UNKNOWN, leaf), { method, redirect: "manual" });
      expect(r.status).toBe(404);
      expect(r.headers.get("location")).toBeNull();
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ error: "audio_not_found" });
      expect(text).not.toContain(UNKNOWN);
    }
    expect(forward).toHaveBeenCalledTimes(2);
  });

  it("404 for an unknown capability on the uplink too", async () => {
    const r = await fetch(url(UNKNOWN, "stream"), {
      method: "POST", headers: { "content-type": "audio/pcm" }, body: Buffer.alloc(10), redirect: "manual",
    });
    expect(r.status).toBe(404);
    expect(r.headers.get("location")).toBeNull();
    expect(await r.text()).not.toContain(UNKNOWN);
  });

  it("does not forward when the capability is live here", async () => {
    const r = await fetch(CLEAR(), { method: "POST" });
    expect(r.status).toBe(200);
    expect(forward).not.toHaveBeenCalled();
  });

  it("hands off to the forward when there is no local session", async () => {
    session.end("stopped");
    forward.mockImplementation(async ({ reply }: any) => { reply.code(299).send({ forwarded: true }); return true; });
    const r = await fetch(CLEAR(), { method: "POST" });
    expect(r.status).toBe(299);
  });

  it("404 once the session has ended (lookup no longer resolves the capability)", async () => {
    session.end("stopped");
    for (const [method, leaf] of [["GET", "stream"], ["POST", "clear"]] as const) {
      const r = await fetch(url(CAP, leaf), { method, redirect: "manual" });
      expect(r.status).toBe(404);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.json()).toEqual({ error: "audio_not_found" });
    }
  });
});

describe("GET stream (SSE)", () => {
  it("streams audio frames as base64 PCM and ends with ended", async () => {
    const res = await fetch(STREAM());
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

  it("409 stream_busy for a second concurrent reader; the first keeps the call", async () => {
    const a = await fetch(STREAM());
    const aEvents = readSse(a, (e) => e.some((x) => x.event === "ended"));
    await new Promise((r) => setTimeout(r, 20));
    const b = await fetch(STREAM());
    expect(b.status).toBe(409);
    expect((await b.json()).error).toBe("stream_busy");
    cap.stdout.emit("data", Buffer.alloc(1920, 1));
    session.end("stopped");
    const events = await aEvents;
    expect(events.map((e) => e.event)).toEqual(["audio", "ended"]);
    expect(events.at(-1)!.data.reason).toBe("stopped");
  });

  it("accepts a reconnect once the first reader has closed", async () => {
    const first = await openRawReader();
    expect(first.status).toBe(200);
    const busy = await fetch(STREAM());
    expect(busy.status).toBe(409);
    first.close();
    await vi.waitFor(() => expect(session.attached).toBe(false), { timeout: 2000 });
    const again = await fetch(STREAM());
    expect(again.status).toBe(200);
    setTimeout(() => cap.stdout.emit("data", Buffer.alloc(1920, 2)), 20);
    const events = await readSse(again, (e) => e.some((x) => x.event === "audio"));
    expect(events[0].event).toBe("audio");
  });
});

describe("GET stream hygiene", () => {
  it("HEAD does not subscribe and does not disturb the live reader", async () => {
    const a = await fetch(STREAM());
    const aEvents = readSse(a, (e) => e.some((x) => x.event === "ended"));
    await new Promise((r) => setTimeout(r, 20));
    const head = await fetch(STREAM(), { method: "HEAD" });
    expect([404, 405]).toContain(head.status);
    cap.stdout.emit("data", Buffer.alloc(1920, 1));
    session.end("stopped");
    const events = await aEvents;
    expect(events.map((e) => e.event)).toEqual(["audio", "ended"]);
    expect(events.at(-1)!.data.reason).toBe("stopped");
  });

  it("a client that disconnects is unsubscribed: frames do not throw and a new reader works", async () => {
    const r = await openRawReader();
    r.close();
    await new Promise((res) => setTimeout(res, 50));
    expect(session.attached).toBe(false);
    expect(() => cap.stdout.emit("data", Buffer.alloc(1920, 1))).not.toThrow();
    const b = await fetch(STREAM());
    setTimeout(() => cap.stdout.emit("data", Buffer.alloc(1920, 2)), 20);
    const events = await readSse(b, (e) => e.some((x) => x.event === "audio"));
    expect(events[0].event).toBe("audio");
  });
});

describe("POST stream (uplink)", () => {
  it("415 for a non-PCM content type", async () => {
    const r = await fetch(STREAM(), {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "a=b",
    });
    expect(r.status).toBe(415);
  });

  it("queues the body, plays it out, answers 200 with played_ms", async () => {
    const r = await fetch(STREAM(), {
      method: "POST", headers: { "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 100), // 100 ms
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ played_ms: 100 });
  });

  it("409 uplink_busy while another uplink is open", async () => {
    const held = session.openUplink();
    expect(typeof held).toBe("object");
    const r = await fetch(STREAM(), {
      method: "POST", headers: { "content-type": "audio/pcm" }, body: Buffer.alloc(10),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("uplink_busy");
  });

  it("answers at once with played_ms when the session ends mid-upload", async () => {
    const body = new PassThrough();
    const answered = new Promise<{ status: number; body: string }>((resolve) => {
      const req = httpRequest(STREAM(), {
        method: "POST", headers: { "content-type": "audio/pcm", "transfer-encoding": "chunked" },
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
    const req = httpRequest(STREAM(), {
      method: "POST", headers: { "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.write(Buffer.alloc(48 * 1000));
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    await vi.waitFor(() => expect(typeof session.openUplink()).toBe("object"), { timeout: 2000 });
    expect(session.ended).toBeUndefined();
  });
  it("frees the uplink slot when the client aborts after the body ended", { timeout: 10_000 }, async () => {
    const req = httpRequest(STREAM(), {
      method: "POST", headers: { "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.end(Buffer.alloc(48 * 3000)); // ~3 s, still playing out when we hang up
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    await vi.waitFor(() => expect(typeof session.openUplink()).toBe("object"), { timeout: 1500 });
    expect(session.ended).toBeUndefined();
  });

  it("accepts a parameterised, mixed-case media type", { timeout: 10_000 }, async () => {
    const r = await fetch(STREAM(), {
      method: "POST", headers: { "content-type": "Audio/PCM; rate=24000" }, body: Buffer.alloc(48 * 10),
    });
    expect(r.status).toBe(200);
  });

  it("415 for a media type that only starts with audio/pcm", async () => {
    const r = await fetch(STREAM(), {
      method: "POST", headers: { "content-type": "audio/pcmfoo" }, body: Buffer.alloc(10),
    });
    expect(r.status).toBe(415);
  });
});

describe("POST clear", () => {
  it("returns played and cleared ms", async () => {
    const up = session.openUplink() as any;
    await up.write(Buffer.alloc(48 * 1000));
    const r = await fetch(CLEAR(), { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cleared_ms).toBeGreaterThan(900);
    expect(body).toHaveProperty("played_ms");
  });
});

describe("stalled reader", () => {
  it("drops a reader whose socket stops draining, so a reconnect is not 409", { timeout: 15_000 }, async () => {
    const stallApp = Fastify();
    await registerAudioRoutes(stallApp, { lookup, forward, readerStallMs: 200 });
    await stallApp.listen({ port: 0, host: "127.0.0.1" });
    const port = (stallApp.server.address() as { port: number }).port;
    const path = `/api/browser/audio/${CAP}/stream`;
    try {
      // A reader that never reads: what a peer gone without a FIN looks like from here.
      const stalled = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => { res.pause(); resolve(res); });
        req.on("error", reject);
        req.end();
      });
      expect(stalled.statusCode).toBe(200);
      // Keep feeding until the kernel buffers on both ends are full and the
      // server has seen no drain for readerStallMs. A paused client never
      // reads the server's close, so watch for the slot coming free instead.
      let status = 409;
      while (status === 409) {
        for (let i = 0; i < 500; i++) cap.stdout.emit("data", Buffer.alloc(1920));
        await new Promise((r) => setTimeout(r, 50));
        const again = await fetch(`http://127.0.0.1:${port}${path}`);
        status = again.status;
        await again.body?.cancel();
      }
      expect(status).toBe(200);
      stalled.destroy();
    } finally {
      await stallApp.close();
    }
  });
});

describe("malformed and unmatched paths", () => {
  it("a capability that is not the minted shape is a 404 without lookup or forward", async () => {
    for (const c of ["short", "%2e%2e", "A".repeat(23), "A".repeat(21) + "="]) {
      const r = await fetch(url(c, "clear"), { method: "POST" });
      expect(r.status).toBe(404);
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("any other path under the prefix is the same JSON 404, matched by a route", async () => {
    let route: unknown = "none";
    const a = Fastify();
    a.addHook("onResponse", async (req) => { route = req.routeOptions?.url; });
    await registerAudioRoutes(a, { lookup, forward });
    const r = await a.inject({ method: "GET", url: `/api/browser/audio/${CAP}/bogus` });
    await a.close();
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "audio_not_found" });
    expect(route).toBe("/api/browser/audio/*");
    expect(forward).not.toHaveBeenCalled();
  });
});
