// HTTP face of the audio pipeline, keyed by a capability:
//   GET  /api/browser/audio/:cap/stream  → SSE, call audio out
//   POST /api/browser/audio/:cap/stream  → chunked audio/pcm in, held open for the call
//   POST /api/browser/audio/:cap/clear   → drop unplayed agent audio
// The capability is the only credential (audio/capability.ts): the voice
// client holding the call carries no workbench token, and any Authorization
// header is ignored. Unknown, revoked and ended all answer the same 404 and
// never redirect.
// Spec: docs/superpowers/specs/2026-10-07-browser-audio-pipeline-design.md
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionForCapability } from "./capability";
import { forwardAudioStream } from "./stream-forward";
import type { AudioSession } from "./session";

export const PING_MS = 15_000;
/**
 * A reader whose socket has not drained for this long is dropped. A peer that
 * vanished without a FIN (half-open TCP) would otherwise hold the one reader
 * slot until the kernel gave up retransmitting, minutes later, and every
 * reconnect in between would get 409.
 */
export const READER_STALL_MS = 10_000;

export interface AudioRouteDeps {
  lookup(cap: string): AudioSession | undefined;
  forward(opts: { request: FastifyRequest; reply: FastifyReply }): Promise<boolean>;
  readerStallMs: number;
}

type Params = { Params: { cap: string } };

export async function registerAudioRoutes(app: FastifyInstance, overrides: Partial<AudioRouteDeps> = {}): Promise<void> {
  const deps: AudioRouteDeps = {
    lookup: overrides.lookup ?? sessionForCapability,
    forward: overrides.forward ?? forwardAudioStream,
    readerStallMs: overrides.readerStallMs ?? READER_STALL_MS,
  };

  /**
   * The session this capability opens, "handled" when the request was piped
   * to the process that owns it, or null after a 404 has been sent. The 404
   * body is the same for every miss and never echoes the capability.
   */
  async function resolve(
    request: FastifyRequest<Params>,
    reply: FastifyReply
  ): Promise<AudioSession | "handled" | null> {
    const s = deps.lookup(request.params.cap);
    if (s) return s;
    if (await deps.forward({ request, reply })) return "handled";
    reply.code(404).send({ error: "audio_not_found" });
    return null;
  }

  await app.register(async (scope) => {
    // The uplink body is a raw PCM stream. Every parser this scope inherits —
    // the built-ins and any app-level one such as OAuth's form parser — would
    // otherwise win over the catch-all and leave nothing to stream
    // (docs/findings/2026-09-15-workspace-inherited-form-parser.md).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    const base = "/api/browser/audio/:cap";

    scope.get<Params>(`${base}/stream`, { exposeHeadRoute: false }, async (request, reply) => {
      const s = await resolve(request, reply);
      if (!s || s === "handled") return reply;

      // Subscribe before the headers go out, so a second concurrent reader
      // gets a plain 409 rather than a 200 that ends at once.
      const queued: string[] = [];
      let res: typeof reply.raw | undefined;
      let ping: ReturnType<typeof setInterval> | undefined;
      let congestedSince = 0;
      const send = (chunk: string): boolean => {
        if (!res) { queued.push(chunk); return true; }
        try { return res.write(chunk); } catch { return true; /* gone */ }
      };
      const unsubscribe = s.subscribe((e) => {
        if (e.event === "audio" && congestedSince) {
          if (Date.now() - congestedSince >= deps.readerStallMs) res?.destroy();
          return;
        }
        // A reader that cannot keep up loses audio frames (the seq gap tells
        // it), never control events, and never makes this process buffer
        // without bound.
        if (!send(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`) && !congestedSince) congestedSince = Date.now();
        if (e.event === "ended" && res) {
          if (ping) clearInterval(ping);
          try { res.end(); } catch { /* noop */ }
        }
      });
      if (unsubscribe === "busy") {
        return reply.code(409).send({ error: "stream_busy", detail: "another reader is connected to this call's audio" });
      }

      reply.hijack();
      res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // Headers sit in Node's buffer until the first body byte; with no audio
      // yet a client (fetch included) would wait on the response line.
      res.write(": open\n\n");
      for (const chunk of queued.splice(0)) send(chunk);
      if (s.ended) {
        try { res.end(); } catch { /* noop */ }
        unsubscribe();
        return reply;
      }

      res.on("drain", () => { congestedSince = 0; });
      ping = setInterval(() => { try { res?.write(": ping\n\n"); } catch { /* noop */ } }, PING_MS);
      ping.unref?.();
      res.on("close", () => {
        clearInterval(ping);
        unsubscribe();
      });
      return reply;
    });

    scope.post<Params>(`${base}/stream`, async (request, reply) => {
      const mediaType = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (mediaType !== "audio/pcm") {
        return reply.code(415).send({ error: "unsupported_media_type", detail: "send Content-Type: audio/pcm (raw s16le mono)" });
      }
      const s = await resolve(request, reply);
      if (!s || s === "handled") return reply;
      const up = s.openUplink();
      if (up === "busy") return reply.code(409).send({ error: "uplink_busy", detail: "another audio POST is open for this call" });
      if (up === "ended") return reply.code(404).send({ error: "audio_not_found" });

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
      const s = await resolve(request, reply);
      if (!s || s === "handled") return reply;
      return reply.send(s.clear());
    });
  });
}
