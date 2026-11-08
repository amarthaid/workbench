import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { config } from "../config";
import { resolveInside, safeRelPath } from "../jots/paths";
import { contentType } from "../jots/mime";
import { extractTarGzToDir, JotExtractError } from "../jots/extract";
import { spacesRoot } from "./dir";
import { consume } from "./pending";
import { getSpace, isValidSpaceName, spaceDir, touchSpace, walkFiles } from "./store";
import { verifySig } from "./sig";
import { SDK_SOURCE } from "./sdk";

// The three path patterns the server owns under /s/. Everything else there,
// including /s/<name> and /s/<name>/, belongs to the portal SPA (the shell).
//   POST /s/upload/:token
//   GET  /s/_sdk/workbench.js
//   GET  /s/:name/app/<sig>/*   (one wildcard route: /s/:name/app/*)

/**
 * The origins a Space document may load from and be framed by: the server's
 * (SERVER_PUBLIC_URL, where /s/ is served) and the portal's (PORTAL_URL, which
 * embeds the iframe and through which the relative appUrl is fetched, e.g. the
 * Vite dev server). Deduplicated, so a single-origin deployment lists one.
 */
export function spaceOrigins(): string[] {
  const out: string[] = [];
  for (const url of [config.SERVER_PUBLIC_URL, config.PORTAL_URL]) {
    if (!url) continue;
    try {
      const o = new URL(url).origin;
      if (!out.includes(o)) out.push(o);
    } catch {
      /* not a URL: skip */
    }
  }
  return out;
}

/** The exact Content-Security-Policy every Space file and the SDK carry. */
export function spaceCsp(origins: readonly string[] = spaceOrigins()): string {
  const o = origins.join(" ");
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src 'self' ${o} 'unsafe-inline' 'unsafe-eval'`,
    `style-src 'self' ${o} 'unsafe-inline'`,
    `img-src 'self' ${o} data: blob:`,
    `font-src 'self' ${o} data:`,
    `media-src 'self' ${o} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${o}`,
  ].join("; ");
}

// CORP is cross-origin on purpose: the document is opaque-origin, so every
// subresource it loads (its own scripts, CSS, images, the SDK) is a
// cross-origin no-cors request, which same-origin would block. The sig in the
// path is the access control. See docs/findings/2026-11-07-spaces-bridge.md.
function setSpaceHeaders(reply: FastifyReply, cacheControl = "private, no-store"): void {
  reply.header("content-security-policy", spaceCsp());
  reply.header("x-content-type-options", "nosniff");
  reply.header("cross-origin-resource-policy", "cross-origin");
  reply.header("referrer-policy", "no-referrer");
  reply.header("cache-control", cacheControl);
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Not found" });
}

// A patch overlays an archive onto the live tree, so the merged result is
// measured again against the limits.
function measureTree(dir: string): { files: number; bytes: number } {
  const files = walkFiles(dir);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
}

export async function registerSpaceRoutes(app: FastifyInstance): Promise<void> {
  // Raw request stream for the gzip upload (no buffering, no 1 MB bodyLimit).
  // Guarded: the jot routes register the same parsers.
  for (const ct of ["application/gzip", "application/x-gzip"]) {
    if (!app.hasContentTypeParser(ct)) {
      app.addContentTypeParser(ct, (_req, payload, done) => done(null, payload));
    }
  }

  app.get("/s/_sdk/workbench.js", async (_req, reply) => {
    setSpaceHeaders(reply, "public, max-age=86400");
    reply.header("content-type", "text/javascript; charset=utf-8");
    return reply.send(SDK_SOURCE);
  });

  app.post<{ Params: { token: string } }>("/s/upload/:token", async (req, reply) => {
    const pending = await consume(req.params.token);
    if (!pending) return notFound(reply);

    // The Space may have been deleted or (after a delete) re-created by
    // someone else between mint and upload.
    const space = await getSpace(pending.name);
    if (!space) return reply.code(404).send({ error: "NOT_FOUND" });
    if (space.ownerId !== pending.owner) return reply.code(403).send({ error: "FORBIDDEN" });

    const root = spacesRoot();
    fs.mkdirSync(root, { recursive: true });
    const tmpDir = path.join(root, `${pending.name}.up-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const discard = () => fs.rmSync(tmpDir, { recursive: true, force: true });

    if (pending.mode === "patch") {
      // Stage a copy of the live tree (none yet is fine: a patch can be the
      // first upload), drop the deleted paths, then overlay the archive, so an
      // uploaded path wins over a delete of itself.
      const live = spaceDir(pending.name);
      if (fs.existsSync(live)) fs.cpSync(live, tmpDir, { recursive: true });
      for (const d of pending.deletes ?? []) {
        const rel = safeRelPath(d);
        if (!rel) {
          discard();
          return reply.code(400).send({ error: "INVALID_PATH" });
        }
        fs.rmSync(path.join(tmpDir, rel), { recursive: true, force: true });
      }
    }

    try {
      await extractTarGzToDir(req.raw, tmpDir);
    } catch (e) {
      discard();
      if (e instanceof JotExtractError) {
        const status = e.code === "TOO_LARGE" || e.code === "TOO_MANY_FILES" ? 413 : 400;
        return reply.code(status).send({ error: e.code });
      }
      return reply.code(400).send({ error: "BAD_ARCHIVE" });
    }

    if (pending.mode === "patch") {
      const merged = measureTree(tmpDir);
      const overflow =
        merged.bytes > config.JOTS_MAX_BYTES
          ? "TOO_LARGE"
          : merged.files > config.JOTS_MAX_FILES
            ? "TOO_MANY_FILES"
            : null;
      if (overflow) {
        discard();
        return reply.code(413).send({ error: overflow });
      }
    }

    if (!fs.existsSync(path.join(tmpDir, "index.html"))) {
      discard();
      return reply.code(400).send({ error: "NO_INDEX" });
    }

    const finalDir = spaceDir(pending.name);
    try {
      // Not atomic on macOS (rename cannot replace a non-empty dir), so the old
      // tree goes first. Same brief gap as jots.
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(tmpDir, finalDir);
    } catch (e) {
      discard();
      console.error("[spaces] commit failed:", e);
      return reply.code(500).send({ error: "DEPLOY_FAILED" });
    }
    await touchSpace(pending.name);
    return reply.code(200).send({ name: pending.name, url: `${config.PORTAL_URL}/s/${pending.name}` });
  });

  // The sig is the first segment of the wildcard tail rather than a :sig
  // param: find-my-way caps params at 100 characters, and a sig carries the
  // viewer id, whose length the server does not control.
  app.get<{ Params: { name: string; "*": string } }>("/s/:name/app/*", async (req, reply) => {
    const { name } = req.params;
    const tail = req.params["*"] ?? "";
    const slash = tail.indexOf("/");
    if (slash <= 0) return notFound(reply);
    const sig = tail.slice(0, slash);
    const rest = tail.slice(slash + 1);
    if (!isValidSpaceName(name)) return notFound(reply);
    if (!verifySig(name, sig)) return notFound(reply);

    const dir = spaceDir(name);
    if (!fs.existsSync(path.join(dir, "index.html"))) return notFound(reply);
    const filePath = resolveInside(dir, rest);
    if (!filePath) return notFound(reply);

    let target = filePath;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      return notFound(reply);
    }
    if (stat.isDirectory()) {
      target = path.join(target, "index.html");
      if (!fs.existsSync(target)) return notFound(reply);
    }
    setSpaceHeaders(reply);
    reply.header("content-type", contentType(target));
    return reply.send(fs.readFileSync(target));
  });
}
