import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import WebSocket from "ws";
import { config } from "../config";
import { verifySession } from "./session";
import { defaultTab, getWarmSession } from "./browser-session";

// Browser-facing CDP transport: plain HTTP instead of a WebSocket, and
// routable across replicas.
//
// Chromium only speaks CDP over a WebSocket, so the server↔chromium hop is
// still a socket (see the dialer below). What the *browser* talks to is:
//
//   POST <base>/attach    → mint this user's browser-session key. Nothing else:
//                           no chromium, no channel, no state.
//   GET  <base>/events    → SSE: chromium → client CDP messages
//   POST <base>/commands  → client → chromium CDP commands (batched). The
//                           first one STARTS chromium on the replica that
//                           receives it.
//   POST <base>/detach    → tear the view down
//
// Two things get better by dropping the socket. Auth stops being in-band: a
// WebSocket can't carry an Authorization header, which is why the old proxy
// took the portal bearer inside a JSON "auth" frame; every endpoint here is a
// normal request that carries the header. And nothing in the path needs to
// forward an Upgrade — a reverse proxy that only streams HTTP is enough.
//
// ─── Why attach commits nothing ───────────────────────────────────────────
//
// A browser session is process-local (see
// docs/findings/2026-09-10-browser-session-pod-affinity.md), so across
// replicas every request touching one has to reach the replica that owns it.
// `attach` is the one request that cannot be routed yet — the client has no
// key to route on — so it must not be the request that commits the pinned
// resource. It only mints the key. The first `commands` starts chromium
// wherever the key routes, and the key keeps every later request going there.
//
// The key is `HMAC(SESSION_SECRET, userId)`, which makes it *stable per user*
// rather than per attach. That is load-bearing: chromium is one process per
// user holding an exclusive lock on a shared profile directory, so two keys
// for one user would route to two replicas that both spawn on that profile
// and fight over its SingletonLock.
//
// It is a ROUTING KEY, NOT A CREDENTIAL. Every endpoint still authenticates
// the portal bearer and checks the key against that user, so a leaked key
// grants nothing on its own; it exists so an L7 proxy can hash on it.

export const SESSION_HEADER = "x-browser-session";

export function mintSessionKey(userId: string): string {
  return createHmac("sha256", config.SESSION_SECRET)
    .update(`browser-session:${userId}`)
    .digest("base64url");
}

export function verifySessionKey(key: string | undefined, userId: string): boolean {
  if (!key) return false;
  const expected = Buffer.from(mintSessionKey(userId));
  const given = Buffer.from(key);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

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

let dial: Dialer = wsDialer;
// Test seam: the chromium socket is the one thing a unit test cannot have.
export function _setDialer(next: Dialer | null): void {
  dial = next ?? wsDialer;
}

// ─── Channels ─────────────────────────────────────────────────────────────

export type SseEventName = "ready" | "cdp" | "closed";
export type ChannelSink = (event: SseEventName, data?: string) => void;

// One channel per user, because chromium is one process per user. It exists
// before anything is started: `link` stays null until the first command.
export interface CdpChannel {
  userId: string;
  link: UpstreamLink | null;
  // Shared by concurrent first commands so a burst starts chromium once.
  starting: Promise<void> | null;
  // At most one SSE stream drains a channel. Messages arriving with no stream
  // attached are dropped — nothing asked for them.
  sink: ChannelSink | null;
  lastActivity: number;
  closed: boolean;
}

// A channel with no stream attached is either waiting for a reconnect or
// abandoned; either way it should not hold a chromium socket for long.
export const CHANNEL_IDLE_MS = 120_000;
export const KEEPALIVE_MS = 15_000;
// Bound on one /commands batch — the client coalesces input events, and an
// unbounded array is free memory for a caller to burn.
export const MAX_BATCH = 64;

const channels = new Map<string, CdpChannel>();

function getOrCreateChannel(userId: string): CdpChannel {
  const existing = channels.get(userId);
  if (existing && !existing.closed) {
    existing.lastActivity = Date.now();
    return existing;
  }
  const channel: CdpChannel = {
    userId,
    link: null,
    starting: null,
    sink: null,
    lastActivity: Date.now(),
    closed: false,
  };
  channels.set(userId, channel);
  return channel;
}

export function getChannel(userId: string): CdpChannel | undefined {
  const channel = channels.get(userId);
  return channel && !channel.closed ? channel : undefined;
}

// Start chromium for this channel if it isn't running yet. This is the call
// that pins the session to this replica.
async function ensureUpstream(channel: CdpChannel): Promise<void> {
  if (channel.link) return;
  if (channel.starting) return channel.starting;
  channel.starting = (async () => {
    // defaultTab, not ensureSession: closing the default tab (or its socket
    // dying) leaves cdpPageWsUrl pointing at a dead target, and defaultTab is
    // the only thing that re-adopts a live page and rewrites that url.
    await defaultTab(channel.userId);
    if (channel.closed) return;
    const session = getWarmSession(channel.userId);
    if (!session) return;
    channel.link = dial(session.cdpPageWsUrl, {
      onMessage: (text) => {
        channel.lastActivity = Date.now();
        channel.sink?.("cdp", text);
      },
      onClose: () => closeChannel(channel.userId),
    });
  })();
  try {
    await channel.starting;
  } finally {
    channel.starting = null;
  }
}

export function closeChannel(userId: string): void {
  const channel = channels.get(userId);
  if (!channel) return;
  channels.delete(userId);
  channel.closed = true;
  const sink = channel.sink;
  channel.sink = null;
  sink?.("closed");
  try { channel.link?.close(); } catch { /* noop */ }
  channel.link = null;
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
  for (const msg of list) channel.link?.send(JSON.stringify(msg));
  channel.lastActivity = Date.now();
  return list.length;
}

export function reapIdleChannels(now = Date.now()): void {
  for (const [userId, channel] of channels) {
    if (channel.sink) continue;
    if (now - channel.lastActivity > CHANNEL_IDLE_MS) closeChannel(userId);
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
  for (const userId of [...channels.keys()]) closeChannel(userId);
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

// Every request past attach must carry the routing key. Requiring it is the
// point: a client that forgets it would otherwise work on a single replica and
// fail intermittently behind a load balancer, which is the worst of both.
function keyed(request: FastifyRequest, reply: FastifyReply, userId: string): boolean {
  const header = request.headers[SESSION_HEADER];
  const key = Array.isArray(header) ? header[0] : header;
  if (!verifySessionKey(key, userId)) {
    reply.status(400).send({ error: "BAD_SESSION_KEY", header: SESSION_HEADER });
    return false;
  }
  return true;
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
// browser-session view. The key is per user, so it is valid on either.
const CDP_BASES = ["/api/auth/cookie/:integration/cdp", "/api/browser-session/cdp"] as const;

export function registerCdpBridgeRoutes(app: FastifyInstance): void {
  for (const base of CDP_BASES) {
    // Mint. Unrouted by definition — the caller has no key yet — so it starts
    // nothing and is safe on any replica. Idempotent: same user, same key.
    app.post(`${base}/attach`, async (request, reply) => {
      const userId = await guard(request, reply);
      if (!userId) return reply;
      return reply.status(201).send({
        sessionKey: mintSessionKey(userId),
        header: SESSION_HEADER,
        keepAliveMs: KEEPALIVE_MS,
        maxBatch: MAX_BATCH,
      });
    });

    app.get(`${base}/events`, async (request, reply) => {
      const userId = await guard(request, reply, true);
      if (!userId) return reply;
      if (!keyed(request, reply, userId)) return reply;
      const channel = getOrCreateChannel(userId);

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

      // Last stream wins. A refreshed tab can arrive before the old response
      // is noticed as dead, and refusing the new one would strand the user
      // behind a stream nobody is reading.
      const previous = channel.sink;
      channel.sink = null;
      previous?.("closed");

      const keepAlive = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* noop */ }
      }, KEEPALIVE_MS);
      keepAlive.unref?.();

      const mine: ChannelSink = (event, data) => {
        writeSse(res, event, data);
        if (event === "closed") {
          clearInterval(keepAlive);
          try { res.end(); } catch { /* noop */ }
        }
      };
      channel.sink = mine;
      // "ready" means the stream is attached, NOT that chromium is running —
      // it may not be yet. The client sends its first command on this signal,
      // and that command is what starts chromium.
      writeSse(res, "ready");

      const done = () => {
        clearInterval(keepAlive);
        // Only tear down if we are still the current stream; a takeover has
        // already moved the channel on.
        if (channel.sink === mine) {
          channel.sink = null;
          // A dropped stream means a gone client: don't leave chromium
          // screencasting into nothing. Reconnecting re-attaches.
          closeChannel(channel.userId);
        }
        try { res.end(); } catch { /* noop */ }
      };
      request.raw.on("close", done);
      request.raw.on("error", done);
      return reply;
    });

    app.post<{ Body: unknown }>(`${base}/commands`, async (request, reply) => {
      const userId = await guard(request, reply);
      if (!userId) return reply;
      if (!keyed(request, reply, userId)) return reply;
      const channel = getOrCreateChannel(userId);
      try {
        // The first command through here spawns chromium and pins the session
        // to this replica.
        await ensureUpstream(channel);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // A spawn already in flight for this user is transient, not fatal —
        // say so with a retryable status instead of failing the view.
        if (message.startsWith("BROWSER_SESSION_BUSY")) {
          return reply.status(409).send({ error: "BROWSER_SESSION_BUSY" });
        }
        return reply.status(503).send({ error: "BROWSER_START_FAILED", message });
      }
      const sent = sendCommands(channel, request.body);
      if (sent === null) return reply.status(400).send({ error: "BAD_COMMANDS" });
      return reply.status(202).send({ sent });
    });

    app.post(`${base}/detach`, async (request, reply) => {
      const userId = await guard(request, reply);
      if (!userId) return reply;
      if (!keyed(request, reply, userId)) return reply;
      closeChannel(userId);
      return reply.status(204).send();
    });
  }
}
