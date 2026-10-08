// Streaming twin of auth/affinity-forward.ts for the audio endpoints. That one
// buffers a JSON body under a 30 s timeout; an SSE stream and an uplink held
// open for a whole call need both directions piped and no timeout at all.
// node:http rather than fetch: undici's default headersTimeout (300 s) would
// kill any uplink longer than five minutes, because its response headers only
// arrive when the call ends.
//
// Same rules as the buffered forward: the routing key is derived from the
// authenticated user, never taken from the client; an inbound key that
// verifies for this user means "you are the owner", so handle locally.
import http from "node:http";
import https from "node:https";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { SESSION_HEADER, mintSessionKey, verifySessionKey } from "../auth/cdp-bridge";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te", "trailer"]);
const PASS_THROUGH = ["authorization", "x-workbench-api-key", "content-type", "accept"];

export async function forwardAudioStream(opts: {
  userId: string;
  request: FastifyRequest;
  reply: FastifyReply;
  internalUrl?: string;
}): Promise<boolean> {
  const { userId, request, reply } = opts;
  const internal = opts.internalUrl ?? config.INTERNAL_MCP_URL;
  if (!internal) return false;
  const inbound = request.headers[SESSION_HEADER];
  if (verifySessionKey(Array.isArray(inbound) ? inbound[0] : inbound, userId)) return false;

  const target = new URL(request.url, internal);
  const headers: Record<string, string> = { [SESSION_HEADER]: mintSessionKey(userId) };
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
