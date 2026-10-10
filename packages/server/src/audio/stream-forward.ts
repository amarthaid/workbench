// Streaming twin of auth/affinity-forward.ts for the audio endpoints. That one
// buffers a JSON body under a 30 s timeout; an SSE stream and an uplink held
// open for a whole call need both directions piped and no timeout at all.
// node:http rather than fetch: undici's default headersTimeout (300 s) would
// kill any uplink longer than five minutes, because its response headers only
// arrive when the call ends.
//
// The audio routes authenticate by capability, not by user, so this hop
// cannot derive the routing key: it relays the caller's own X-Browser-Session
// (browser_audio_start hands it out alongside the URLs) and the mesh hashes it
// onto the owner. The key only routes; the owner still checks the capability.
// A request that already made the hop is answered where it lands, so an
// unknown capability is one 404, never a loop.
import http from "node:http";
import https from "node:https";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { SESSION_HEADER } from "../auth/cdp-bridge";

export const HOP_HEADER = "x-workbench-audio-hop";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te", "trailer"]);
// No credentials: the capability in the path is the only one these routes take.
const PASS_THROUGH = ["content-type", "accept"];
// mintSessionKey's output: base64url of a SHA-256 HMAC.
const SESSION_KEY = /^[A-Za-z0-9_-]{43}$/;

export async function forwardAudioStream(opts: {
  request: FastifyRequest;
  reply: FastifyReply;
  /** The audio route to hit on the owner, built by the route from a validated capability. */
  path: string;
  internalUrl?: string;
}): Promise<boolean> {
  const { request, reply } = opts;
  const internal = opts.internalUrl ?? config.INTERNAL_MCP_URL;
  if (!internal) return false;
  if (request.headers[HOP_HEADER] !== undefined) return false;
  const inbound = request.headers[SESSION_HEADER];
  const key = Array.isArray(inbound) ? inbound[0] : inbound;
  if (!key || !SESSION_KEY.test(key)) return false;

  // Nothing from the request target reaches the upstream URL: the origin is
  // ours and the path is the route's own, built from a validated capability.
  // Parsing the raw target instead would let an absolute-form target pick the
  // host, and `new URL` resolves `%2e%2e` as a dot segment, so an
  // unauthenticated caller could walk the forward off the audio routes.
  if (!/^\/api\/browser\/audio\/[A-Za-z0-9_-]+\/(stream|clear)$/.test(opts.path)) return false;
  const base = new URL(internal);
  const target = new URL(base.origin);
  target.pathname = opts.path;
  const headers: Record<string, string> = { [SESSION_HEADER]: key, [HOP_HEADER]: "1" };
  for (const h of PASS_THROUGH) {
    const v = request.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  const isPost = request.method === "POST";
  if (isPost) headers["transfer-encoding"] = "chunked";

  return new Promise<boolean>((resolve) => {
    let responded = false;
    const mod = target.protocol === "https:" ? https : http;
    const upstream = mod.request(target, { method: request.method, headers }, (res) => {
      responded = true;
      reply.hijack();
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      }
      reply.raw.writeHead(res.statusCode ?? 502, out);
      // Owner socket died mid-body: the reply is already ours, so end it
      // rather than answering (the caller only 404s on a false return).
      res.on("error", () => { reply.raw.destroy(); upstream.destroy(); });
      res.on("aborted", () => { reply.raw.destroy(); });
      res.pipe(reply.raw);
      resolve(true);
    });
    upstream.on("error", () => {
      if (!responded) {
        request.raw.unpipe(upstream);
        resolve(false);
      } else {
        reply.raw.destroy();
      }
    });
    // Client gone (agent hung up, or the SSE reader went away): tear the hop down
    // so the owner sees the disconnect too and frees the reader / uplink slot.
    // For an uplink the owner answers only at the end, so a close with the
    // response unfinished is an abort.
    reply.raw.on("close", () => { if (!reply.raw.writableFinished) upstream.destroy(); });
    request.raw.on("aborted", () => upstream.destroy());
    if (isPost) request.raw.pipe(upstream);
    else upstream.end();
  });
}
