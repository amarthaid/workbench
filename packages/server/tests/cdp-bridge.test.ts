import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { verifySessionMock, ensureSessionMock, sessionFor } = vi.hoisted(() => ({
  verifySessionMock: (token: string) => {
    if (token === "user-1-jwt") return Promise.resolve({ userId: "user-1" });
    if (token === "user-2-jwt") return Promise.resolve({ userId: "user-2" });
    return Promise.reject(new Error("Invalid token"));
  },
  ensureSessionMock: vi.fn(),
  sessionFor: (userId: string) => ({
    userId,
    cdpPageWsUrl: `ws://127.0.0.1:9222/devtools/page/${userId}`,
  }),
}));

vi.mock("../src/config", () => ({
  config: {
    PORTAL_URL: "http://localhost:5173",
    SERVER_PUBLIC_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
  },
}));
vi.mock("../src/auth/session", () => ({ verifySession: verifySessionMock }));
// The bridge warms the session through defaultTab, then reads the (possibly
// re-adopted) default page url back off the session.
vi.mock("../src/auth/browser-session", () => ({
  defaultTab: ensureSessionMock,
  getWarmSession: sessionFor,
}));

import {
  registerCdpBridgeRoutes,
  mintSessionKey,
  SESSION_HEADER,
  reapIdleChannels,
  getChannel,
  CHANNEL_IDLE_MS,
  MAX_BATCH,
  _resetChannels,
  _setDialer,
  type UpstreamHandlers,
} from "../src/auth/cdp-bridge";

const BASE = "/api/browser-session/cdp";
const ORIGIN = "http://localhost:5173";

// Stand-in for the chromium socket: records what the bridge sends upstream and
// lets a test push messages back down.
interface FakeLink {
  target: string;
  sent: string[];
  closed: boolean;
  handlers: UpstreamHandlers;
}
let links: FakeLink[] = [];

function headers(token = "user-1-jwt", key?: string): Record<string, string> {
  const userId = token === "user-2-jwt" ? "user-2" : "user-1";
  return {
    origin: ORIGIN,
    authorization: `Bearer ${token}`,
    [SESSION_HEADER]: key ?? mintSessionKey(userId),
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  links = [];
  ensureSessionMock.mockReset();
  ensureSessionMock.mockImplementation(async (userId: string) => sessionFor(userId));
  _setDialer((target, handlers) => {
    const link: FakeLink = { target, sent: [], closed: false, handlers };
    links.push(link);
    return {
      send: (text: string) => link.sent.push(text),
      close: () => {
        link.closed = true;
      },
    };
  });
  app = Fastify();
  registerCdpBridgeRoutes(app);
  await app.ready();
});

afterEach(async () => {
  _resetChannels();
  _setDialer(null);
  await app.close();
});

const command = { id: 1, method: "Page.enable" };

describe("attach mints a routing key and nothing else", () => {
  it("starts no browser and dials nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: ORIGIN, authorization: "Bearer user-1-jwt" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      sessionKey: mintSessionKey("user-1"),
      header: SESSION_HEADER,
    });
    // The whole point: the unrouted request commits no pinned resource.
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
    expect(getChannel("user-1")).toBeUndefined();
  });

  it("is idempotent — one stable key per user, so one replica per user", async () => {
    const first = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: ORIGIN, authorization: "Bearer user-1-jwt" },
    });
    const second = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: ORIGIN, authorization: "Bearer user-1-jwt" },
    });
    expect(first.json().sessionKey).toBe(second.json().sessionKey);
  });

  it("gives different users different keys", () => {
    expect(mintSessionKey("user-1")).not.toBe(mintSessionKey("user-2"));
  });

  it("needs a bearer and an allowed origin", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: ORIGIN },
    });
    expect(noAuth.statusCode).toBe(401);
    const badOrigin = await app.inject({
      method: "POST",
      url: `${BASE}/attach`,
      headers: { origin: "https://evil.example.com", authorization: "Bearer user-1-jwt" },
    });
    expect(badOrigin.statusCode).toBe(403);
  });
});

// The key routes requests; it never authorizes them. Authorization stays the
// portal bearer on every single request, and the session a request reaches is
// always the bearer's own.
describe("the key is a routing hint, not a credential", () => {
  it("grants nothing without a bearer", async () => {
    for (const [method, url] of [
      ["POST", `${BASE}/commands`],
      ["GET", `${BASE}/events`],
      ["POST", `${BASE}/detach`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: { origin: ORIGIN, [SESSION_HEADER]: mintSessionKey("user-1") },
        ...(method === "POST" ? { payload: command } : {}),
      });
      expect(res.statusCode).toBe(401);
    }
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(links).toHaveLength(0);
  });

  it("refuses another user's key and starts nothing for either user", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers("user-2-jwt", mintSessionKey("user-1")),
      payload: command,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("BAD_SESSION_KEY");
    expect(ensureSessionMock).not.toHaveBeenCalled();
    expect(getChannel("user-1")).toBeUndefined();
    expect(getChannel("user-2")).toBeUndefined();
  });

  it("refuses a missing or forged key", async () => {
    const missing = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: { origin: ORIGIN, authorization: "Bearer user-1-jwt" },
      payload: command,
    });
    expect(missing.statusCode).toBe(400);
    const forged = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers("user-1-jwt", "not-a-real-key"),
      payload: command,
    });
    expect(forged.statusCode).toBe(400);
    expect(links).toHaveLength(0);
  });

  it("keeps each user on their own browser session", async () => {
    await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers("user-1-jwt"),
      payload: { id: 1, method: "Page.enable" },
    });
    await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers("user-2-jwt"),
      payload: { id: 1, method: "Runtime.enable" },
    });

    // One session per authenticated user, resolved from the bearer — never
    // from the key.
    expect(ensureSessionMock.mock.calls.map((c) => c[0])).toEqual(["user-1", "user-2"]);
    expect(links).toHaveLength(2);
    expect(links[0].target).toContain("user-1");
    expect(links[1].target).toContain("user-2");
    expect(links[0].sent.map((s) => JSON.parse(s).method)).toEqual(["Page.enable"]);
    expect(links[1].sent.map((s) => JSON.parse(s).method)).toEqual(["Runtime.enable"]);
  });
});

describe("the first command starts the browser", () => {
  it("dials on first use and forwards the batch", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: [
        { id: 1, method: "Page.enable" },
        { id: 2, method: "Page.startScreencast", params: { format: "jpeg" } },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ sent: 2 });
    expect(ensureSessionMock).toHaveBeenCalledWith("user-1");
    expect(links).toHaveLength(1);
    expect(links[0].sent).toHaveLength(2);
  });

  it("reuses the browser for later commands", async () => {
    for (const method of ["Page.enable", "Input.dispatchMouseEvent", "Page.captureScreenshot"]) {
      const res = await app.inject({
        method: "POST",
        url: `${BASE}/commands`,
        headers: headers(),
        payload: { id: 1, method },
      });
      expect(res.statusCode).toBe(202);
    }
    expect(links).toHaveLength(1);
    expect(links[0].sent).toHaveLength(3);
  });

  it("starts the browser once for a burst of concurrent first commands", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: "POST",
          url: `${BASE}/commands`,
          headers: headers(),
          payload: { id: i, method: "Page.enable" },
        })
      )
    );
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(links).toHaveLength(1);
    expect(links[0].sent).toHaveLength(5);
  });

  it("409s a spawn already in flight rather than failing the view", async () => {
    ensureSessionMock.mockRejectedValue(
      new Error("BROWSER_SESSION_BUSY: a browser session is already active for this user")
    );
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: command,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("BROWSER_SESSION_BUSY");
    expect(links).toHaveLength(0);
  });

  it("503s when the browser cannot start", async () => {
    ensureSessionMock.mockRejectedValue(new Error("chromium exited (code 21)"));
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: command,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("BROWSER_START_FAILED");
  });

  it("400s a payload that is not a list of CDP commands", async () => {
    for (const payload of [[{ id: 1 }], ["Page.enable"], [], [{ method: 5 }]]) {
      const res = await app.inject({
        method: "POST",
        url: `${BASE}/commands`,
        headers: headers(),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("400s a batch over the cap", async () => {
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: Array.from({ length: MAX_BATCH + 1 }, (_, i) => ({ id: i, method: "Page.enable" })),
    });
    expect(res.statusCode).toBe(400);
  });

  it("serves the cookie-capture path shape too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/cookie/acme/cdp/commands",
      headers: headers(),
      payload: command,
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("teardown", () => {
  it("detach closes the browser socket and retires the channel", async () => {
    await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: command,
    });
    const res = await app.inject({ method: "POST", url: `${BASE}/detach`, headers: headers() });
    expect(res.statusCode).toBe(204);
    expect(links[0].closed).toBe(true);
    expect(getChannel("user-1")).toBeUndefined();
  });

  it("a chromium-side close retires the channel", async () => {
    await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: command,
    });
    links[0].handlers.onClose();
    expect(getChannel("user-1")).toBeUndefined();
  });

  it("reaps a channel whose stream went away", async () => {
    await app.inject({
      method: "POST",
      url: `${BASE}/commands`,
      headers: headers(),
      payload: command,
    });
    reapIdleChannels(Date.now() + CHANNEL_IDLE_MS + 1);
    expect(links[0].closed).toBe(true);
    expect(getChannel("user-1")).toBeUndefined();
  });
});

describe("event stream", () => {
  async function listen() {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    return `http://127.0.0.1:${port}`;
  }

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

  it("opens before the browser exists, then carries its messages", async () => {
    const origin = await listen();
    const stream = await fetch(`${origin}${BASE}/events`, { headers: headers() });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const frames = readFrames(stream.body!);

    // "ready" means the stream is attached — chromium is NOT running yet.
    expect(await frames()).toEqual({ event: "ready", data: "" });
    expect(links).toHaveLength(0);
    expect(ensureSessionMock).not.toHaveBeenCalled();

    // The first command is what starts it; frames follow on the same stream.
    await fetch(`${origin}${BASE}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify({ id: 1, method: "Page.startScreencast" }),
    });
    expect(links).toHaveLength(1);
    const payload = JSON.stringify({ method: "Page.screencastFrame", params: { data: "AAA" } });
    links[0].handlers.onMessage(payload);
    expect(await frames()).toEqual({ event: "cdp", data: payload });
  });

  it("hands the channel to a reconnecting stream instead of refusing it", async () => {
    const origin = await listen();
    const first = await fetch(`${origin}${BASE}/events`, { headers: headers() });
    const firstFrames = readFrames(first.body!);
    expect((await firstFrames()).event).toBe("ready");
    await fetch(`${origin}${BASE}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify(command),
    });

    const second = await fetch(`${origin}${BASE}/events`, { headers: headers() });
    const secondFrames = readFrames(second.body!);
    expect((await secondFrames()).event).toBe("ready");
    // The stranded stream is closed out...
    expect((await firstFrames()).event).toBe("closed");
    // ...but the browser it was watching survives the handover.
    expect(links[0].closed).toBe(false);
    const payload = JSON.stringify({ method: "Page.screencastFrame", params: { data: "BBB" } });
    links[0].handlers.onMessage(payload);
    expect(await secondFrames()).toEqual({ event: "cdp", data: payload });
  });

  it("streams to a same-origin GET, which carries no Origin header at all", async () => {
    // Per Fetch, a browser omits Origin on same-origin GET — the stream would
    // be unreachable if it demanded the header like the POSTs do.
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/events`,
      headers: {
        authorization: "Bearer user-1-jwt",
        [SESSION_HEADER]: mintSessionKey("user-1"),
      },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    res.stream().destroy();
  });

  it("still requires the routing key on the stream", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${BASE}/events`,
      headers: { origin: ORIGIN, authorization: "Bearer user-1-jwt" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ends the stream when chromium goes away mid-view", async () => {
    const origin = await listen();
    const stream = await fetch(`${origin}${BASE}/events`, { headers: headers() });
    const frames = readFrames(stream.body!);
    expect((await frames()).event).toBe("ready");
    await fetch(`${origin}${BASE}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify(command),
    });

    links[0].handlers.onClose();
    expect(await frames()).toEqual({ event: "closed", data: "" });
    await expect(frames()).rejects.toThrow("stream ended");
  });

  it("closes the channel when the client drops the stream", async () => {
    const origin = await listen();
    const controller = new AbortController();
    const stream = await fetch(`${origin}${BASE}/events`, {
      headers: headers(),
      signal: controller.signal,
    });
    const frames = readFrames(stream.body!);
    expect((await frames()).event).toBe("ready");
    await fetch(`${origin}${BASE}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers() },
      body: JSON.stringify(command),
    });
    controller.abort();
    await vi.waitFor(() => expect(links[0].closed).toBe(true));
    expect(getChannel("user-1")).toBeUndefined();
  });
});
