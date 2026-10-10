import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";
import net from "node:net";

const cfg = vi.hoisted(() => ({
  SERVER_PUBLIC_URL: "http://localhost:3000",
  SESSION_SECRET: "test-session-secret-32-chars-long!!",
  INTERNAL_MCP_URL: undefined as string | undefined,
}));
vi.mock("../src/config", () => ({ config: cfg }));

import { registerAudioRoutes } from "../src/audio/routes";
import { forwardAudioStream, HOP_HEADER } from "../src/audio/stream-forward";
import { AudioSession } from "../src/audio/session";

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
const ownerHits = vi.fn<(headers: http.IncomingHttpHeaders) => void>();

// Synthetic capability and routing key (the key only has to match the
// 43-char base64url shape mintSessionKey produces).
const CAP = "capAAAAAAAAAAAAAAAAAAA";
const KEY = "K".repeat(43);
const H = { "x-browser-session": KEY };
const path = (leaf: "stream" | "clear", c = CAP) => `/api/browser/audio/${c}/${leaf}`;

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
  owner.addHook("onRequest", async (req) => { ownerHits(req.headers); });
  await registerAudioRoutes(owner, {
    lookup: (c) => (c === CAP && !session.ended ? session : undefined),
    forward: (o) => forwardAudioStream({ ...o, internalUrl: `${ownerUrl}/mcp` }),
  });
  ownerUrl = await listen(owner);
  entry = Fastify();
  await registerAudioRoutes(entry, {
    lookup: () => undefined,
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

describe("forwardAudioStream", () => {
  it("pipes the SSE stream from the owner, relaying X-Browser-Session verbatim and marking the hop", async () => {
    const res = await fetch(`${entryUrl}${path("stream")}`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(ownerHits).toHaveBeenCalledTimes(1);
    const seen = ownerHits.mock.calls[0][0];
    expect(seen["x-browser-session"]).toBe(KEY);
    expect(seen[HOP_HEADER]).toBe("1");
    setTimeout(() => cap.stdout.emit("data", Buffer.alloc(1920, 3)), 30);
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: audio")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"seq":0');
    await reader.cancel();
  }, 10_000);

  it("pipes a chunked uplink body to the owner and relays the final 200", async () => {
    const res = await fetch(`${entryUrl}${path("stream")}`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 60),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 60 });
  }, 10_000);

  it("relays clear", async () => {
    const res = await fetch(`${entryUrl}${path("clear")}`, { method: "POST", headers: H });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 0, cleared_ms: 0 });
  }, 10_000);

  it("an unknown capability is one owner-side 404, relayed without a second hop", async () => {
    const res = await fetch(`${entryUrl}${path("clear", "capZZZZZZZZZZZZZZZZZZZ")}`, { method: "POST", headers: H, redirect: "manual" });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.json()).toEqual({ error: "audio_not_found" });
    // The owner got the forwarded request and, seeing the hop header, did not forward again.
    expect(ownerHits).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("does not forward without an X-Browser-Session header", async () => {
    const res = await fetch(`${entryUrl}${path("clear")}`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(ownerHits).not.toHaveBeenCalled();
  }, 10_000);

  for (const bad of ["short", "K".repeat(42), "K".repeat(44), `${"K".repeat(42)}=`, `${"K".repeat(42)}.`]) {
    it(`does not forward a malformed X-Browser-Session (${JSON.stringify(bad)})`, async () => {
      const res = await fetch(`${entryUrl}${path("clear")}`, { method: "POST", headers: { "x-browser-session": bad } });
      expect(res.status).toBe(404);
      expect(ownerHits).not.toHaveBeenCalled();
    }, 10_000);
  }

  it("does not forward a request that already made the hop (loop guard)", async () => {
    const res = await fetch(`${entryUrl}${path("clear")}`, { method: "POST", headers: { ...H, [HOP_HEADER]: "1" } });
    expect(res.status).toBe(404);
    expect(ownerHits).not.toHaveBeenCalled();
  }, 10_000);

  it("forwards no credentials: Authorization and X-Workbench-Api-Key stay behind", async () => {
    const res = await fetch(`${entryUrl}${path("clear")}`, {
      method: "POST",
      headers: { ...H, authorization: "Bearer tok-abc", "x-workbench-api-key": "wb-fake-key", cookie: "sid=fake" },
    });
    expect(res.status).toBe(200);
    const seen = ownerHits.mock.calls[0][0];
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-workbench-api-key"]).toBeUndefined();
    expect(seen.cookie).toBeUndefined();
    expect(seen["x-browser-session"]).toBe(KEY);
    expect(seen[HOP_HEADER]).toBe("1");
  }, 10_000);

  it("passes content-type and accept through on the uplink", async () => {
    const res = await fetch(`${entryUrl}${path("stream")}`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm", accept: "application/json" }, body: Buffer.alloc(48 * 10),
    });
    expect(res.status).toBe(200);
    const seen = ownerHits.mock.calls[0][0];
    expect(seen["content-type"]).toBe("audio/pcm");
    expect(seen.accept).toBe("application/json");
  }, 10_000);

  it("falls through to a local 404 when the owner is unreachable", async () => {
    await owner.close();
    const res = await fetch(`${entryUrl}${path("clear")}`, { method: "POST", headers: H });
    expect(res.status).toBe(404);
  }, 10_000);

  it("returns false with no internal URL configured", async () => {
    const out = await forwardAudioStream({ request: { headers: { ...H } } as any, reply: {} as any });
    expect(out).toBe(false);
  }, 10_000);

  it("ends the client response when the owner dies mid-body (no 404 on a used reply)", async () => {
    const dying = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      setTimeout(() => res.socket!.destroy(), 50);
    });
    await new Promise<void>((r) => dying.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(dying.address() as { port: number }).port}`;
    const lone = Fastify();
    await registerAudioRoutes(lone, {
      lookup: () => undefined,
      forward: (o) => forwardAudioStream({ ...o, internalUrl: `${url}/mcp` }),
    });
    const loneUrl = await listen(lone);
    try {
      const res = await fetch(`${loneUrl}${path("stream")}`, { headers: H });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      // The stream ends or errors; it must not hang and must not become a 404.
      await Promise.race([
        (async () => { try { while (!(await reader.read()).done); } catch { /* reset is an end */ } })(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("client response never ended")), 5000)),
      ]);
    } finally {
      await lone.close();
      dying.close();
    }
  }, 10_000);

  it("a client abort mid-upload reaches the owner, which frees the uplink slot", async () => {
    const entryPort = new URL(entryUrl).port;
    const req = http.request({
      host: "127.0.0.1", port: entryPort, method: "POST",
      path: path("stream"),
      headers: { ...H, "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.write(Buffer.alloc(4800));
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();
    const deadline = Date.now() + 1500;
    let status = 0;
    while (Date.now() < deadline) {
      const res = await fetch(`${ownerUrl}${path("stream")}`, {
        method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 10),
      });
      status = res.status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(200);
  }, 10_000);

  for (const [label, target] of [["absolute-form", (p: number) => `http://127.0.0.1:${p}${path("clear")}`], ["protocol-relative", (p: number) => `//127.0.0.1:${p}${path("clear")}`]] as const) {
    it(`never sends the request to a host named in the request target (${label})`, async () => {
      let hit = false;
      const attacker = http.createServer((_q, r) => { hit = true; r.end(); });
      await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
      const aport = (attacker.address() as { port: number }).port;
      const status = await new Promise<string>((resolve) => {
        const sock = net.connect(Number(new URL(entryUrl).port), "127.0.0.1", () => {
          sock.write(`POST ${target(aport)} HTTP/1.1\r\nHost: 127.0.0.1\r\nx-browser-session: ${KEY}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
        });
        let buf = "";
        sock.on("data", (d) => { buf += d; });
        sock.on("close", () => resolve(buf.split("\r\n")[0]));
        sock.on("error", () => resolve("error"));
      });
      await new Promise((r) => setTimeout(r, 200));
      attacker.close();
      expect(hit).toBe(false);
      // Absolute-form: Fastify routes the path, so 200 proves the forward ran and
      // the owner answered (a router change cannot make this a silent no-op).
      // A `//host/...` target matches no route and 404s before any forward.
      expect(status).toBe(label === "absolute-form" ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found");
    }, 10_000);
  }
});
