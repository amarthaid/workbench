import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import WebSocket from "ws";
import { config } from "../config";
import { verifySession } from "./session";
import { authorizeCdpAttach } from "./cdp-authz";

// Browser-facing CDP transport: plain HTTP instead of a WebSocket.
//
// Chromium only speaks CDP over a WebSocket, so the server↔chromium hop is
// still a socket (see the dialer below). What the *browser* talks to is a
// three-endpoint REST + SSE bridge over one channel:
//
//   POST <base>/attach            → dial chromium, mint a channelId
//   GET  <base>/events?channel=   → SSE: chromium → client CDP messages
//   POST <base>/commands?channel= → client → chromium CDP commands (batched)
//   POST <base>/detach?channel=   → tear the channel down
//
// Two things get better by dropping the socket. Auth stops being in-band: a
// WebSocket can't carry an Authorization header, which is why the old proxy
// took the portal bearer inside a JSON "auth" frame; every endpoint here is a
// normal request that carries the header, so nothing has to be trusted from a
// message body. And nothing in the path needs to forward an Upgrade — a
// reverse proxy that only knows how to stream HTTP responses is enough.

// ─── Upstream (chromium) link ─────────────────────────────────────────────

export interface UpstreamLink {
  send(text: string): void;
  close(): void;
}

export interface UpstreamHandlers {
  onMessage(text: string): void;
  onClose(): void;
}

export type Dialer = (target: string, handlers: UpstreamHandlers) => UpstreamLink;

// CDP frames are JSON text — chromium closes the socket (1006) if we send
// Buffers with the binary opcode, and hands us either shape back.
function toText(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

const wsDialer: Dialer = (target, handlers) => {
  // Chromium's CDP WebSocket gates Origin against --remote-allow-origins.
  // Send a known origin from our side and match it on the chromium args
  // (`http://127.0.0.1`).
  const ws = new WebSocket(target, { perMessageDeflate: false, origin: "http://127.0.0.1" });
  const queue: string[] = [];
  let open = false;
  ws.on("open", () => {
    open = true;
    for (const msg of queue) ws.send(msg);
    queue.length = 0;
  });
  ws.on("message", (data: WebSocket.RawData) => handlers.onMessage(toText(data)));
  ws.on("close", () => handlers.onClose());
  ws.on("error", () => handlers.onClose());
  return {
    send(text: string) {
      if (open && ws.readyState === WebSocket.OPEN) ws.send(text);
      else queue.push(text);
    },
    close() {
      try { ws.close(); } catch { /* noop */ }
    },
  };
};

// ─── Channels ─────────────────────────────────────────────────────────────

export type SseEventName = "ready" | "cdp" | "closed";
export type ChannelSink = (event: SseEventName, data?: string) => void;

export interface CdpChannel {
  id: string;
  userId: string;
  link: UpstreamLink;
  // At most one SSE stream drains a channel. Messages that arrive with no
  // stream attached are dropped: the client attaches before it enables any
  // CDP domain, so an unattached channel has nothing to say.
  sink: ChannelSink | null;
  lastActivity: number;
  closed: boolean;
}

// A channel that is attached but never streamed (client died between the two
// requests) would otherwise hold a chromium socket open forever.
export const CHANNEL_IDLE_MS = 120_000;
export const KEEPALIVE_MS = 15_000;
// Bound on one /commands batch — the client coalesces input events, and an
// unbounded array is free memory for a caller to burn.
export const MAX_BATCH = 64;

const channels = new Map<string, CdpChannel>();

export function createChannel(userId: string, target: string, dial: Dialer = wsDialer): CdpChannel {
  const channel: CdpChannel = {
    id: randomUUID(),
    userId,
    link: { send: () => undefined, close: () => undefined },
    sink: null,
    lastActivity: Date.now(),
    closed: false,
  };
  channels.set(channel.id, channel);
  channel.link = dial(target, {
    onMessage: (text) => {
      channel.lastActivity = Date.now();
      channel.sink?.("cdp", text);
    },
    onClose: () => closeChannel(channel.id),
  });
  return channel;
}

// Look a channel up as its owner. A channelId is a handle, not a credential:
// the caller still has to prove the same userId that opened it.
export function getChannel(id: string | undefined, userId: string): CdpChannel | null {
  if (!id) return null;
  const channel = channels.get(id);
  if (!channel || channel.closed || channel.userId !== userId) return null;
  channel.lastActivity = Date.now();
  return channel;
}

export function closeChannel(id: string): void {
  const channel = channels.get(id);
  if (!channel) return;
  channels.delete(id);
  channel.closed = true;
  const sink = channel.sink;
  channel.sink = null;
  sink?.("closed");
  try { channel.link.close(); } catch { /* noop */ }
}

// Forward a batch of client CDP commands upstream. Returns the number sent,
// or null if the batch isn't a list of CDP command objects.
export function sendCommands(channel: CdpChannel, body: unknown): number | null {
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0 || list.length > MAX_BATCH) return null;
  for (const msg of list) {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
    if (typeof (msg as { method?: unknown }).method !== "string") return null;
  }
  for (const msg of list) channel.link.send(JSON.stringify(msg));
  channel.lastActivity = Date.now();
  return list.length;
}

export function reapIdleChannels(now = Date.now()): void {
  for (const [id, channel] of channels) {
    if (channel.sink) continue;
    if (now - channel.lastActivity > CHANNEL_IDLE_MS) closeChannel(id);
  }
}

let reaperStarted = false;
export function startChannelReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => reapIdleChannels(), 30_000).unref();
}

// Test seam.
export function _resetChannels(): void {
  for (const id of [...channels.keys()]) closeChannel(id);
}

// ─── Request guards ───────────────────────────────────────────────────────

// Session JWT (Authorization: Bearer) — the portal's own credential. An API
// key is deliberately not accepted: driving a live browser is a human action
// from the portal, not something an agent's key should reach.
export async function userIdFromBearer(auth?: string): Promise<string | null> {
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    const session = await verifySession(auth.slice(7));
    return session.userId;
  } catch {
    return null;
  }
}

// Origin allowlist for the browser-driven endpoints. The bearer already makes
// these immune to a cookie-borne CSRF, but a wrong-origin caller has no
// business here at all, so it never reaches the channel map.
export function isOriginAllowed(origin: string | undefined): boolean {
  const allowed = new Set<string>([config.PORTAL_URL, config.SERVER_PUBLIC_URL].filter(Boolean));
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return allowed.has(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

// `allowMissingOrigin` exists for exactly one route. Per Fetch, a browser
// sends no Origin on a same-origin GET, so the event stream cannot require the
// header the way the side-effecting POSTs do. Nothing is lost: a cross-origin
// reader (fetch, XHR, EventSource) does send Origin and gets rejected here, and
// a tag-based load that omits it cannot set Authorization, so it 401s instead.
async function guard(
  request: FastifyRequest,
  reply: FastifyReply,
  allowMissingOrigin = false
): Promise<string | null> {
  const origin = request.headers.origin;
  if (!(allowMissingOrigin && origin === undefined) && !isOriginAllowed(origin)) {
    reply.status(403).send({ error: "Origin not allowed" });
    return null;
  }
  const userId = await userIdFromBearer(request.headers.authorization);
  if (!userId) {
    reply.status(401).send({ error: "Unauthorized" });
    return null;
  }
  return userId;
}

// ─── SSE framing ──────────────────────────────────────────────────────────

function writeSse(res: ServerResponse, event: SseEventName, data?: string): void {
  let frame = `event: ${event}\n`;
  // A CDP message is single-line JSON, but a payload with an embedded newline
  // would silently split into two events — spell the multi-line form out.
  if (data !== undefined) for (const line of data.split("\n")) frame += `data: ${line}\n`;
  try { res.write(`${frame}\n`); } catch { /* client went away */ }
}

// ─── Routes ───────────────────────────────────────────────────────────────

// Both live-view flows share one implementation: cookie-auth capture (whose
// path carries the integration for readability only) and the warm
// browser-session view. Auth for both resolves through the session's cdpToken.
const CDP_BASES = ["/api/auth/cookie/:integration/cdp", "/api/browser-session/cdp"] as const;

export function registerCdpBridgeRoutes(app: FastifyInstance): void {
  for (const base of CDP_BASES) {
    app.post<{ Body: { sessionId?: string; cdpToken?: string } }>(
      `${base}/attach`,
      async (request, reply) => {
        const userId = await guard(request, reply);
        if (!userId) return reply;
        const target = await authorizeCdpAttach(
          { sessionId: request.body?.sessionId, cdpToken: request.body?.cdpToken },
          userId
        );
        if (!target) return reply.status(401).send({ error: "Unauthorized" });
        const channel = createChannel(userId, target);
        return reply.status(201).send({
          channelId: channel.id,
          keepAliveMs: KEEPALIVE_MS,
          maxBatch: MAX_BATCH,
        });
      }
    );

    app.get<{ Querystring: { channel?: string } }>(`${base}/events`, async (request, reply) => {
      const userId = await guard(request, reply, true);
      if (!userId) return reply;
      const channel = getChannel(request.query.channel, userId);
      if (!channel) return reply.status(404).send({ error: "NO_CHANNEL" });
      if (channel.sink) return reply.status(409).send({ error: "STREAM_IN_USE" });

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        // no-transform keeps a compressing proxy from buffering the stream;
        // X-Accel-Buffering does the same for nginx specifically.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* noop */ }
      }, KEEPALIVE_MS);
      keepAlive.unref?.();

      channel.sink = (event, data) => {
        writeSse(res, event, data);
        // "closed" is the last thing a channel ever says — end the response
        // rather than leaving the client holding an open stream.
        if (event === "closed") {
          clearInterval(keepAlive);
          try { res.end(); } catch { /* noop */ }
        }
      };
      // The client waits for this before sending any CDP command, exactly as
      // it waited for the old socket's {"type":"ready"} frame.
      writeSse(res, "ready");

      const done = () => {
        clearInterval(keepAlive);
        if (channel.sink) {
          channel.sink = null;
          // A dropped stream means a gone client: don't leave chromium
          // screencasting into nothing. Reconnecting means a fresh attach.
          closeChannel(channel.id);
        }
        try { res.end(); } catch { /* noop */ }
      };
      request.raw.on("close", done);
      request.raw.on("error", done);
      return reply;
    });

    app.post<{ Querystring: { channel?: string }; Body: unknown }>(
      `${base}/commands`,
      async (request, reply) => {
        const userId = await guard(request, reply);
        if (!userId) return reply;
        const channel = getChannel(request.query.channel, userId);
        if (!channel) return reply.status(404).send({ error: "NO_CHANNEL" });
        const sent = sendCommands(channel, request.body);
        if (sent === null) return reply.status(400).send({ error: "BAD_COMMANDS" });
        return reply.status(202).send({ sent });
      }
    );

    app.post<{ Querystring: { channel?: string } }>(`${base}/detach`, async (request, reply) => {
      const userId = await guard(request, reply);
      if (!userId) return reply;
      const channel = getChannel(request.query.channel, userId);
      if (channel) closeChannel(channel.id);
      return reply.status(204).send();
    });
  }
}
