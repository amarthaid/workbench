import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import http from "node:http";

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
  }, 10_000);

  it("pipes a chunked uplink body to the owner and relays the final 200", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/stream`, {
      method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 60),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 60 });
  }, 10_000);

  it("relays clear", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ played_ms: 0, cleared_ms: 0 });
  }, 10_000);

  it("handles locally when the inbound key already verifies (loop guard)", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, {
      method: "POST", headers: { ...H, "x-browser-session": mintSessionKey("user-1") },
    });
    expect(res.status).toBe(404);
    expect(ownerHits).not.toHaveBeenCalled();
  }, 10_000);

  it("forwards anyway when the inbound key belongs to someone else", async () => {
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, {
      method: "POST", headers: { ...H, "x-browser-session": mintSessionKey("user-2") },
    });
    expect(res.status).toBe(200);
  }, 10_000);

  it("falls through to a local 404 when the owner is unreachable", async () => {
    await owner.close();
    const res = await fetch(`${entryUrl}/api/browser/tabs/T1/audio/clear`, { method: "POST", headers: H });
    expect(res.status).toBe(404);
  }, 10_000);

  it("returns false with no internal URL configured", async () => {
    const out = await forwardAudioStream({ userId: "user-1", request: { headers: {} } as any, reply: {} as any });
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
      getAudio: () => undefined,
      forward: (o) => forwardAudioStream({ ...o, internalUrl: `${url}/mcp` }),
    });
    const loneUrl = await listen(lone);
    try {
      const res = await fetch(`${loneUrl}/api/browser/tabs/T1/audio/stream`, { headers: H });
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
      path: "/api/browser/tabs/T1/audio/stream",
      headers: { ...H, "content-type": "audio/pcm", "transfer-encoding": "chunked" },
    });
    req.on("error", () => undefined);
    req.write(Buffer.alloc(4800));
    await new Promise((r) => setTimeout(r, 200));
    req.destroy();
    const deadline = Date.now() + 1500;
    let status = 0;
    while (Date.now() < deadline) {
      const res = await fetch(`${ownerUrl}/api/browser/tabs/T1/audio/stream`, {
        method: "POST", headers: { ...H, "content-type": "audio/pcm" }, body: Buffer.alloc(48 * 10),
      });
      status = res.status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status).toBe(200);
  }, 10_000);
});
