// HTTP face of the audio pipeline, keyed by tab:
//   GET  /api/browser/tabs/:session_id/audio/stream  → SSE, call audio out
//   POST /api/browser/tabs/:session_id/audio/stream  → chunked audio/pcm in, held open for the call
//   POST /api/browser/tabs/:session_id/audio/clear   → drop unplayed agent audio
// Spec: docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import { getAudio as defaultGetAudio } from "./manager";
import { forwardAudioStream } from "./stream-forward";
import type { AudioSession } from "./session";

export const PING_MS = 15_000;

export interface AudioRouteDeps {
  getAudio(userId: string): AudioSession | undefined;
  forward(opts: { userId: string; request: FastifyRequest; reply: FastifyReply }): Promise<boolean>;
}

type Params = { Params: { session_id: string } };

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

export async function registerAudioRoutes(app: FastifyInstance, overrides: Partial<AudioRouteDeps> = {}): Promise<void> {
  const deps: AudioRouteDeps = {
    getAudio: overrides.getAudio ?? defaultGetAudio,
    forward: overrides.forward ?? forwardAudioStream,
  };

  /**
   * The session for this tab, "handled" when the request was piped to the
   * owning pod, or null after a 404 has been sent. A session on *another* tab
   * means this process owns the user's chromium: answer here, never forward.
   */
  async function resolve(
    userId: string,
    request: FastifyRequest<Params>,
    reply: FastifyReply
  ): Promise<AudioSession | "handled" | null> {
    const s = deps.getAudio(userId);
    if (s && s.tabId === request.params.session_id) return s;
    if (!s && (await deps.forward({ userId, request, reply }))) return "handled";
    reply.code(404).send({
      error: "audio_not_started",
      detail: s
        ? `audio is running on session_id ${s.tabId}, not this one`
        : "call browser_audio_start for this session_id first",
    });
    return null;
  }

  await app.register(async (scope) => {
    // The uplink body is a raw PCM stream. Every parser this scope inherits —
    // the built-ins and any app-level one such as OAuth's form parser — would
    // otherwise win over the catch-all and leave nothing to stream
    // (docs/findings/2026-09-15-workspace-inherited-form-parser.md).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    const base = "/api/browser/tabs/:session_id/audio";

    scope.get<Params>(`${base}/stream`, { exposeHeadRoute: false }, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Headers sit in Node's buffer until the first body byte; with no audio
      // yet a client (fetch included) would wait on the response line.
      res.write(": open\n\n");

      // A reader that cannot keep up loses audio frames (the seq gap tells it),
      // never control events, and never makes this process buffer without bound.
      let congested = false;
      res.on("drain", () => { congested = false; });
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* noop */ } }, PING_MS);
      ping.unref?.();

      const unsubscribe = s.subscribe((e) => {
        if (e.event === "audio" && congested) return;
        let ok = true;
        try { ok = res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`); } catch { /* gone */ }
        if (!ok) congested = true;
        if (e.event === "ended") {
          clearInterval(ping);
          try { res.end(); } catch { /* noop */ }
        }
      });
      res.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return reply;
    });

    scope.post<Params>(`${base}/stream`, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const mediaType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (mediaType !== "audio/pcm") {
        return reply.code(415).send({ error: "unsupported_media_type", detail: "send Content-Type: audio/pcm (raw s16le mono)" });
      }
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;
      const up = s.openUplink();
      if (up === "busy") return reply.code(409).send({ error: "uplink_busy", detail: "another audio POST is open for this call" });
      if (up === "ended") return reply.code(404).send({ error: "audio_not_started" });

      // The response's 'close', not the request's: IncomingMessage closes once
      // the body is consumed, long before the queued audio has played out.
      reply.raw.on("close", () => { if (!reply.raw.writableFinished) up.abort(); });

      const pump = (async () => {
        for await (const chunk of request.raw) {
          await up.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
      })();
      const outcome = await Promise.race([
        pump.then(() => "eof" as const, () => "aborted" as const),
        up.sessionEnded.then(() => "ended" as const),
      ]);
      if (outcome === "aborted") {
        up.abort();
        reply.hijack();
        return reply;
      }
      const result = await up.end();
      if (outcome === "ended") {
        // The agent is still writing into a call that is over: answer now and
        // let the connection close rather than read audio nobody will play.
        pump.catch(() => undefined);
        return reply.header("connection", "close").send(result);
      }
      return reply.send(result);
    });

    scope.post<Params>(`${base}/clear`, async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const s = await resolve(userId, request, reply);
      if (!s || s === "handled") return reply;
      return reply.send(s.clear());
    });
  });
}
