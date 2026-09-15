import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import { resolveExistingFile } from "./paths";
import { consumeUpload, peekDownload, revokeFor } from "./presign";
import {
  deleteFile,
  listFiles,
  openWriteStream,
  statFile,
  usedBytes,
  WorkspaceError,
} from "./store";

// Strip anything that could break out of the quoted filename in a
// Content-Disposition header. The name reaches us from a remote server's own
// Content-Disposition when the browser captured the download, so it is
// attacker-controlled and must never be able to inject a header.
function sanitizeHeaderFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, "_").replace(/[\x00-\x1f\x7f]/g, "") || "download";
}

/**
 * Headers for every byte this module serves, presigned or bearer.
 *
 * registerPortal serves the portal SPA at "/" on this same Fastify instance,
 * and the portal keeps its bearer in a client-side token store. So a
 * user-controlled file served inline from this origin is stored XSS against
 * that credential — an uploaded .html would run with access to it. The content
 * type is therefore never sniffed and never the real one, and the disposition
 * is never inline.
 *
 * sandbox + nosniff mirror setJotSecurityHeaders (jots/routes.ts), which exists
 * for the same reason; this is the stricter version, because a jot is meant to
 * render and a workspace file never is.
 */
export function setFileSecurityHeaders(reply: FastifyReply, filename: string): void {
  reply.header("content-type", "application/octet-stream");
  reply.header("content-disposition", `attachment; filename="${sanitizeHeaderFilename(filename)}"`);
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "sandbox");
  reply.header("cross-origin-resource-policy", "same-origin");
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

function statusForError(code: string): number {
  switch (code) {
    case "INVALID_NAME":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "TOO_LARGE":
      return 413;
    case "QUOTA_EXCEEDED":
      return 507;
    default:
      return 500;
  }
}

/** Stream a workspace file out. Shared by the bearer route and the presigned one. */
export async function sendWorkspaceFile(
  reply: FastifyReply,
  userId: string,
  name: string
): Promise<FastifyReply> {
  // resolveExistingFile, not userFilePath: this is a read, so the symlink check
  // applies. A symlink inside the workspace pointing at the token database
  // passes pure path arithmetic.
  const abs = await resolveExistingFile(userId, name);
  const entry = abs ? await statFile(userId, name) : null;
  if (!abs || !entry) return reply.code(404).send({ error: "NOT_FOUND" });

  setFileSecurityHeaders(reply, entry.name);
  reply.header("content-length", String(entry.bytes));
  reply.header("x-workspace-expires-at", entry.expiresAt);
  // Streamed, never read into memory: buffering a 100 MB file per request is a
  // denial of service with extra steps.
  return reply.send(createReadStream(abs));
}

/** Consume a raw request stream into the workspace under `name`. */
export async function receiveWorkspaceFile(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  name: string
): Promise<FastifyReply> {
  let handle;
  try {
    handle = await openWriteStream(userId, name);
  } catch (e) {
    const code = e instanceof WorkspaceError ? e.code : "INVALID_NAME";
    return reply.code(statusForError(code)).send({ error: code });
  }

  try {
    for await (const chunk of request.raw) {
      await handle.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    const entry = await handle.commit();
    return reply.code(201).send(entry);
  } catch (e) {
    await handle.abort();
    const code = e instanceof WorkspaceError ? e.code : "UPLOAD_FAILED";
    return reply.code(statusForError(code)).send({ error: code });
  }
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scope) => {
    // Uploads arrive as a raw body of arbitrary type. Fastify's exact-match
    // parsers beat any regex one, so every parser this scope inherits has to be
    // removed before a catch-all can win — same ordering trap as the REST tool
    // endpoint (docs/findings/2026-09-11-rest-tool-execution-endpoint.md).
    // Not just the two built-ins: any route group registered earlier on the app
    // (OAuth's application/x-www-form-urlencoded, jots' gzip types) is inherited
    // too, and a parser that turns the body into an object leaves the route with
    // nothing to stream — a 0-byte file and a 201.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

    scope.get("/api/files", async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const files = await listFiles(userId);
      return reply.send({
        files,
        usedBytes: files.reduce((n, f) => n + f.bytes, 0),
        quotaBytes: config.WORKSPACE_MAX_BYTES_PER_USER,
        maxFileBytes: config.WORKSPACE_MAX_FILE_BYTES,
        ttlHours: config.WORKSPACE_TTL_HOURS,
      });
    });

    // NOTE: `:name` is one path segment and find-my-way caps a route param at
    // 100 characters, answering 414 beyond that. Workspace names are flat and
    // short in practice; a longer one goes through the presigned flow.
    scope.get<{ Params: { name: string } }>("/api/files/:name", async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      return sendWorkspaceFile(reply, userId, request.params.name);
    });

    scope.post<{ Params: { name: string } }>("/api/files/:name", async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      return receiveWorkspaceFile(request, reply, userId, request.params.name);
    });

    scope.delete<{ Params: { name: string } }>("/api/files/:name", async (request, reply) => {
      const userId = await authenticate(request, reply);
      if (!userId) return reply;
      const deleted = await deleteFile(userId, request.params.name);
      if (!deleted) return reply.code(404).send({ error: "NOT_FOUND" });
      // Deleting a file revokes its outstanding presigned URLs: a grant that
      // outlived its file would resurrect it on the next upload redeem.
      await revokeFor(userId, request.params.name);
      return reply.send({ ok: true, usedBytes: await usedBytes(userId) });
    });

    // Presigned redeem routes. No bearer — the token IS the authorization, and
    // the user it belongs to comes from the row, never from the request.
    //
    // Three static segments beat the two-segment /api/files/:name in
    // find-my-way, so these do not collide with a file literally named "dl".
    scope.get<{ Params: { token: string } }>("/api/files/dl/:token", async (request, reply) => {
      const grant = await peekDownload(request.params.token);
      if (!grant) return reply.code(404).send({ error: "NOT_FOUND" });
      return sendWorkspaceFile(reply, grant.userId, grant.name);
    });

    scope.put<{ Params: { token: string } }>("/api/files/ul/:token", async (request, reply) => {
      const grant = await consumeUpload(request.params.token);
      if (!grant) return reply.code(404).send({ error: "NOT_FOUND" });
      // grant.name, never a name off the request: an upload URL that honoured a
      // caller-supplied name would be a write-anywhere primitive.
      return receiveWorkspaceFile(request, reply, grant.userId, grant.name);
    });
  });
}
