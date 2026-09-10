import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// Stand-in for chromium's CDP socket: records what the bridge sends upstream
// and lets a test push messages back down. Defined inside vi.hoisted because
// the ws mock factory runs before this module's own imports exist — hence the
// hand-rolled emitter instead of node:events.
const { FakeSocket, fakeSockets, verifySessionMock, authorizeMock } = vi.hoisted(() => {
  interface Fake {
    url: string;
    readyState: number;
    sent: string[];
    closed: boolean;
    emit(event: string, arg?: unknown): void;
  }
  const sockets: Fake[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    closed = false;
    private handlers = new Map<string, ((arg?: unknown) => void)[]>();
    constructor(readonly url: string) {
      sockets.push(this as unknown as Fake);
      setImmediate(() => this.emit("open"));
    }
    on(event: string, cb: (arg?: unknown) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, arg?: unknown) {
      for (const cb of this.handlers.get(event) ?? []) cb(arg);
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
  }
  return {
    FakeSocket: FakeWebSocket,
    fakeSockets: sockets,
    verifySessionMock: (token: string) => {
      if (token === "user-1-jwt") return Promise.resolve({ userId: "user-1" });
      if (token === "user-2-jwt") return Promise.resolve({ userId: "user-2" });
      return Promise.reject(new Error("Invalid token"));
    },
    authorizeMock: vi.fn(),
  };
});

vi.mock("ws", () => ({ default: FakeSocket }));

vi.mock("../src/config", () => ({
  config: {
    PORTAL_URL: "http://localhost:5173",
    SERVER_PUBLIC_URL: "http://localhost:3000",
  },
}));

vi.mock("../src/auth/session", () => ({ verifySession: verifySessionMock }));

vi.mock("../src/auth/cdp-authz", () => ({ authorizeCdpAttach: authorizeMock }));

import {
  registerCdpBridgeRoutes,
  reapIdleChannels,
  CHANNEL_IDLE_MS,
  MAX_BATCH,
  _resetChannels,
} from "../src/auth/cdp-bridge";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/page/ABC";
const BASE = "/api/browser-session/cdp";
const ORIGIN = "http://localhost:5173";

function headers(token = "user-1-jwt", extra: Record<string, string> = {}) {
  return { origin: ORIGIN, authorization: `Bearer ${token}`, ...extra };
}

let app: FastifyInstance;

beforeEach(async () => {
  fakeSockets.length = 0;
  authorizeMock.mockReset();
  authorizeMock.mockResolvedValue(ENDPOINT);
  app = Fastify();
  registerCdpBridgeRoutes(app);
  await app.ready();
});

afterEach(async () => {
  _resetChannels();
  await app.close();
});

async function attach(token = "user-1-jwt"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `${BASE}/attach`,
    headers: headers(token),
    payload: { sessionId: token === "user-2-jwt" ? "user-2" : "user-1", cdpToken: "ctok" },
  });
  expect(res.statusCode).toBe(201);
  // The upstream dial is async — wait for the fake socket to open.
  await new Promise((r) => setImmediate(r));
  return res.json().channelId as string;
}

describe("cdp bridge attach", () => {
  it("dials chromium and mints a channel for an authorized portal user", async () => {
    const channelId = await attach();
    expect(channelId).toMatch(/[0-9a-f-]{36}/);
    expect(authorizeMock).toHaveBeenCalledWith(
      { sessionId: "user-1", cdpToken: "ctok" },
      "user-1"
    );
    expect(fakeSockets).toHaveLength(1);
    expect(fakeSockets[0].url).toBe(ENDPOINT);
  });

  it("rejects a wrong-origin caller before touching the session", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: "https://evil.example.com", authorization: "Bearer user-1-jwt" },
      payload: { sessionId: "user-1", cdpToken: "ctok" },
    });
    expect(res.statusCode).toBe(403);
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(fakeSockets).toHaveLength(0);
  });

  it("rejects a missing or unverifiable bearer", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: ORIGIN },
      payload: { sessionId: "user-1", cdpToken: "ctok" },
    });
    expect(noAuth.statusCode).toBe(401);
    const badAuth = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: headers("nonsense"),
      payload: { sessionId: "user-1", cdpToken: "ctok" },
    });
    expect(badAuth.statusCode).toBe(401);
    expect(fakeSockets).toHaveLength(0);
  });

  it("401s when the cdpToken does not resolve to a warm session", async () => {
    authorizeMock.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: headers(),
      payload: { sessionId: "user-1", cdpToken: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(fakeSockets).toHaveLength(0);
  });

  it("serves the cookie-capture path shape too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cookie/acme/cdp/attach",
      headers: headers(),
      payload: { sessionId: "user-1", cdpToken: "ctok" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("cdp bridge commands", () => {
  it("forwards a batch of CDP commands upstream", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers(),
      payload: [
        { id: 1, method: "Page.enable", params: {} },
        { id: 2, method: "Page.screencastFrameAck", params: { sessionId: 3 } },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sent: 2 });
    expect(fakeSockets[0].sent.map((s) => JSON.parse(s).method)).toEqual([
      "Page.enable",
      "Page.screencastFrameAck",
    ]);
  });

  it("accepts a single command object as well as an array", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers(),
      payload: { id: 1, method: "Page.enable" },
    });
    expect(res.statusCode).toBe(202);
    expect(fakeSockets[0].sent).toHaveLength(1);
  });

  it("400s on a payload that is not a list of CDP commands", async () => {
    const channelId = await attach();
    for (const payload of [[{ id: 1 }], ["Page.enable"], [], [{ method: 5 }]]) {
      const res = await app.inject({
        method: "POST",
        url: `${BASE}/commands?channel=${channelId}`,
        headers: headers(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(fakeSockets[0].sent).toHaveLength(0);
  });

  it("400s on a batch over the cap", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers(),
      payload: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ id: i, method: "Page.enable" })),
    });
    expect(res.statusCode).toBe(400);
    expect(fakeSockets[0].sent).toHaveLength(0);
  });

  it("hides another user's channel — a channelId is a handle, not a credential", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers("user-2-jwt"),
      payload: { id: 1, method: "Page.enable" },
    });
    expect(res.statusCode).toBe(404);
    expect(fakeSockets[0].sent).toHaveLength(0);
  });

  it("404s an unknown channel", async () => {
    await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=not-a-channel`,
      headers: headers(),
      payload: { id: 1, method: "Page.enable" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("cdp bridge teardown", () => {
  it("detach closes chromium and retires the channel", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/detach?channel=${channelId}`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(204);
    expect(fakeSockets[0].closed).toBe(true);
    const after = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers(),
      payload: { id: 1, method: "Page.enable" },
    });
    expect(after.statusCode).toBe(404);
  });

  it("a chromium-side close retires the channel", async () => {
    const channelId = await attach();
    fakeSockets[0].emit("close");
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands?channel=${channelId}`,
      headers: headers(),
      payload: { id: 1, method: "Page.enable" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("reaps a channel that attached but never opened its stream", async () => {
    await attach();
    reapIdleChannels(Date.now() + CHANNEL_IDLE_MS + 1);
    expect(fakeSockets[0].closed).toBe(true);
  });
});

describe("cdp bridge event stream", () => {
  it("streams ready then chromium messages, and closes the channel when the client leaves", async () => {
    // A hijacked SSE response needs a real socket, not inject's in-memory one.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    const attached = await fetch(`${origin}${BASE}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ sessionId: "user-1", cdpToken: "ctok" }),
    });
    expect(attached.status).toBe(201);
    const { channelId } = (await attached.json()) as { channelId: string };
    await new Promise((r) => setImmediate(r));

    const controller = new AbortController();
    const stream = await fetch(`${origin}${BASE}/events?channel=${channelId}`, {
      headers: headers(),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const frames = readFrames(stream.body!);
    expect(await frames()).toEqual({ event: "ready", data: "" });

    const payload = JSON.stringify({ method: "Page.screencastFrame", params: { data: "AAA" } });
    fakeSockets[0].emit("message", Buffer.from(payload));
    expect(await frames()).toEqual({ event: "cdp", data: payload });

    // A second stream on the same channel is refused rather than splitting it.
    const dup = await fetch(`${origin}${BASE}/events?channel=${channelId}`, { headers: headers() });
    expect(dup.status).toBe(409);

    controller.abort();
    await vi.waitFor(() => expect(fakeSockets[0].closed).toBe(true));
  });

  it("streams to a same-origin GET, which carries no Origin header at all", async () => {
    // Per Fetch, a browser omits Origin on same-origin GET — the stream would
    // be unreachable if it demanded the header like the POSTs do.
    const channelId = await attach();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/events?channel=${channelId}`,
      headers: { authorization: "Bearer user-1-jwt" },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    res.stream().destroy();
  });

  it("still requires an allowed Origin on the side-effecting POSTs", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { authorization: "Bearer user-1-jwt" },
      payload: { sessionId: "user-1", cdpToken: "ctok" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("ends the stream when chromium goes away mid-view", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    const attached = await fetch(`${origin}${BASE}/attach`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ sessionId: "user-1", cdpToken: "ctok" }),
    });
    const { channelId } = (await attached.json()) as { channelId: string };
    await new Promise((r) => setImmediate(r));

    const stream = await fetch(`${origin}${BASE}/events?channel=${channelId}`, {
      headers: headers(),
    });
    const frames = readFrames(stream.body!);
    expect(await frames()).toEqual({ event: "ready", data: "" });

    fakeSockets[0].emit("close");
    expect(await frames()).toEqual({ event: "closed", data: "" });
    // The response is finished, not just informed — the reader sees EOF.
    await expect(frames()).rejects.toThrow("stream ended");
  });

  it("404s a stream for a channel the caller does not own", async () => {
    const channelId = await attach();
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/events?channel=${channelId}`,
      headers: headers("user-2-jwt"),
    });
    expect(res.statusCode).toBe(404);
  });
});

// Pull SSE frames off a response body one blank-line-delimited frame at a
// time, skipping keepalive comments.
function readFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async function next(): Promise<{ event: string; data: string }> {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const lines = frame.split("\n").filter((l) => l && !l.startsWith(":"));
        if (lines.length === 0) continue;
        const event = lines.find((l) => l.startsWith("event:"))!.slice(6).trim();
        const data = lines
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        return { event, data };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
  };
}
