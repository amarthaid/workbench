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

describe("GET stream hygiene", () => {
  it("HEAD does not subscribe and does not replace the live reader", async () => {
    const a = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    const aEvents = readSse(a, (e) => e.some((x) => x.event === "ended"));
    await new Promise((r) => setTimeout(r, 20));
    const head = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { method: "HEAD", headers: H });
    expect([404, 405]).toContain(head.status);
    cap.stdout.emit("data", Buffer.alloc(1920, 1));
    session.end("stopped");
    const events = await aEvents;
    expect(events.map((e) => e.event)).toEqual(["audio", "ended"]);
    expect(events.at(-1)!.data.reason).toBe("stopped");
  });

  it("a client that disconnects is unsubscribed: frames do not throw and a new reader works", async () => {
    const req = httpRequest(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    const gotHeaders = new Promise<import("node:http").IncomingMessage>((r) => req.on("response", r));
    req.end();
    const res = await gotHeaders;
    res.resume();
    res.destroy();
    req.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(session.attached).toBe(false);
    expect(() => cap.stdout.emit("data", Buffer.alloc(1920, 1))).not.toThrow();
    const b = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, { headers: H });
    setTimeout(() => cap.stdout.emit("data", Buffer.alloc(1920, 2)), 20);
    const events = await readSse(b, (e) => e.some((x) => x.event === "audio"));
    expect(events[0].event).toBe("audio");
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
  it("frees the uplink slot when the client aborts after the body ended", { timeout: 10_000 }, async () => {
    const req = httpRequest(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.end(Buffer.alloc(48 * 3000)); // ~3 s, still playing out when we hang up
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    await vi.waitFor(() => expect(typeof session.openUplink()).toBe("object"), { timeout: 1500 });
    expect(session.ended).toBeUndefined();
  });

  it("accepts a parameterised, mixed-case media type", { timeout: 10_000 }, async () => {
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "Audio/PCM; rate=24000" }, body: Buffer.alloc(48 * 10),
    });
    expect(r.status).toBe(200);
  });

  it("415 for a media type that only starts with audio/pcm", async () => {
    const r = await fetch(`${base}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcmfoo" }, body: Buffer.alloc(10),
    });
    expect(r.status).toBe(415);
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
