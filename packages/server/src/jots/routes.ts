import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { jotsRoot } from "./dir";
import { isValidJotName, resolveInside, safeRelPath, MANIFEST } from "./paths";
import { readManifest, commitJotDir, Manifest } from "./store";
import { contentType } from "./mime";
import { verifyPassword, makeToken, verifyToken, cookieName } from "./auth";
import { consume } from "./pending";
import { extractTarGzToDir, JotExtractError } from "./extract";

function secret(): string {
  return config.SESSION_SECRET;
}

function secureCookie(): boolean {
  return config.NODE_ENV === "production";
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function wantsHtml(req: FastifyRequest): boolean {
  const accept = (req.headers["accept"] as string) || "";
  if (req.headers["x-requested-with"]) return false;
  const dest = req.headers["sec-fetch-dest"] as string | undefined;
  if (dest && dest !== "document" && dest !== "iframe") return false;
  return accept.includes("text/html");
}

function unlockPage(jotName: string, error: boolean): string {
  const msg = error ? `<p class="err">Wrong password.</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Locked · ${jotName}</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0e0e10;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
  form{background:#1a1a1e;padding:2rem;border-radius:12px;width:min(320px,90vw);box-shadow:0 10px 40px #0008}
  h1{font-size:1rem;font-weight:600;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #333;background:#0e0e10;color:#eee;margin-bottom:.8rem}
  button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#5b8cff;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#ff6b6b;font-size:.85rem;margin:.2rem 0 .8rem}
</style></head><body>
<form method="POST" action="/j/${jotName}/__auth">
  <h1>🔒 ${jotName}</h1>
  ${msg}
  <input type="password" name="password" placeholder="Password" autofocus required>
  <button type="submit">Unlock</button>
</form></body></html>`;
}

// Every jot response carries untrusted, user-uploaded content. The `sandbox`
// CSP directive forces the browser to treat it as a unique opaque origin, so
// jot JS cannot read app cookies/storage or make credentialed same-origin
// requests to /api or /mcp. allow-scripts + allow-forms keep jots and the
// unlock form working. Trade-off: a jot cannot fetch its own data files
// (opaque origin is cross-origin to itself); jots must be self-contained.
// A sandboxed jot is its own opaque origin, so `fetch('./data.json')` from its
// own script counts as cross-origin and needs CORS to be readable. Opt-in per
// jot, and public-only: an opaque-origin fetch carries no cookies, so on a
// password jot the request would just 401 anyway.
function corsEnabled(manifest: Manifest | null | undefined): boolean {
  return !!manifest && manifest.access === "public" && manifest.cors === true;
}

const CORS_METHODS = "GET, HEAD, OPTIONS";

function setJotSecurityHeaders(reply: FastifyReply, manifest?: Manifest | null): void {
  reply.header("content-security-policy", "sandbox allow-scripts allow-forms");
  reply.header("x-content-type-options", "nosniff");
  reply.header("x-frame-options", "SAMEORIGIN");
  if (corsEnabled(manifest)) {
    reply.header("access-control-allow-origin", "*");
    reply.header("cross-origin-resource-policy", "cross-origin");
  } else {
    reply.header("cross-origin-resource-policy", "same-origin");
  }
}

function streamFile(reply: FastifyReply, filePath: string, manifest?: Manifest | null): void {
  setJotSecurityHeaders(reply, manifest);
  reply.header("content-type", contentType(filePath));
  reply.send(fs.readFileSync(filePath));
}

// Post-merge guard. extractTarGzToDir caps the *archive*; a patch overlays it
// onto an existing tree, so the merged result has to be measured again.
function measureTree(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string, isRoot: boolean): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        walk(path.join(d, e.name), false);
        continue;
      }
      if (!e.isFile()) continue;
      if (isRoot && e.name === MANIFEST) continue;
      files++;
      bytes += fs.statSync(path.join(d, e.name)).size;
    }
  };
  walk(dir, true);
  return { files, bytes };
}

export async function registerJotRoutes(app: FastifyInstance): Promise<void> {
  // Accept urlencoded bodies for the unlock form. Guard: another route group
  // (e.g. OAuth) may have registered this parser earlier in the boot order.
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_req, body, done) => done(null, body)
    );
  }

  // Hand the raw request stream to the upload handler (no buffering) for the
  // gzip content types. This enables streaming extraction and bypasses the
  // default 1 MB bodyLimit. Guarded so a re-register is a no-op.
  for (const ct of ["application/gzip", "application/x-gzip"]) {
    if (!app.hasContentTypeParser(ct)) {
      app.addContentTypeParser(ct, (_req, payload, done) => done(null, payload));
    }
  }

  // Bare /j/:name -> canonical trailing slash.
  app.get<{ Params: { name: string } }>("/j/:name", async (req, reply) => {
    if (!isValidJotName(req.params.name)) return reply.code(404).send("Not found");
    return reply.redirect(`/j/${req.params.name}/`, 301);
  });

  app.post<{ Params: { name: string } }>("/j/:name/__auth", async (req, reply) => {
    const { name } = req.params;
    if (!isValidJotName(name)) return reply.code(404).send("Not found");
    const manifest = readManifest(name);
    if (!manifest) return reply.code(404).send("Not found");
    if (manifest.access !== "password") return reply.redirect(`/j/${name}/`, 302);

    // Body shape depends on which urlencoded parser won registration: the jot
    // parser yields the raw string, but if the OAuth route group registered
    // first (boot order) it's already parsed into an object. Handle both, or
    // password jots never unlock under the real server.
    let pw = "";
    if (typeof req.body === "string") {
      pw = new URLSearchParams(req.body).get("password") || "";
    } else if (req.body && typeof req.body === "object") {
      const v = (req.body as Record<string, unknown>).password;
      pw = typeof v === "string" ? v : "";
    }
    if (!manifest.hash || !verifyPassword(pw, manifest.hash)) {
      setJotSecurityHeaders(reply);
      return reply.code(401).type("text/html; charset=utf-8").send(unlockPage(name, true));
    }
    const token = makeToken(secret(), name, manifest.hash);
    const attrs = [
      `${cookieName(name)}=${token}`,
      `Path=/j/${name}/`,
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=2592000",
    ];
    if (secureCookie()) attrs.push("Secure");
    return reply.header("set-cookie", attrs.join("; ")).redirect(`/j/${name}/`, 302);
  });

  app.post<{ Params: { token: string } }>("/j/upload/:token", async (req, reply) => {
    const pending = await consume(req.params.token);
    if (!pending) return reply.code(404).send("Not found");

    // A patch inherits gating from the live jot rather than from the token, so
    // an update can never silently change who can read the jot.
    let access: "public" | "password";
    let passwordHash: string | undefined;
    let cors: boolean | undefined;
    if (pending.mode === "patch") {
      const live = readManifest(pending.name);
      if (!live) return reply.code(404).send({ error: "NOT_FOUND" });
      if (live.owner !== pending.owner) return reply.code(403).send({ error: "FORBIDDEN" });
      access = live.access;
      passwordHash = live.hash;
      cors = pending.cors ?? live.cors;
    } else {
      if (!pending.access) return reply.code(400).send({ error: "INVALID_ACCESS" });
      access = pending.access;
      passwordHash = pending.passwordHash;
      cors = pending.cors;
    }

    fs.mkdirSync(jotsRoot(), { recursive: true });
    const tmpDir = path.join(jotsRoot(), `${pending.name}.up-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    if (pending.mode === "patch") {
      // Stage a copy of the live tree, drop the deleted paths, then let the
      // archive overlay it — so an uploaded path wins over a delete of itself.
      fs.cpSync(path.join(jotsRoot(), pending.name), tmpDir, { recursive: true });
      for (const d of pending.deletes ?? []) {
        const rel = safeRelPath(d);
        if (!rel) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          return reply.code(400).send({ error: "INVALID_PATH" });
        }
        fs.rmSync(path.join(tmpDir, rel), { recursive: true, force: true });
      }
    }

    try {
      await extractTarGzToDir(req.raw, tmpDir);
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (e instanceof JotExtractError) {
        const status = e.code === "TOO_LARGE" || e.code === "TOO_MANY_FILES" ? 413 : 400;
        return reply.code(status).send({ error: e.code });
      }
      return reply.code(400).send({ error: "BAD_ARCHIVE" });
    }

    if (pending.mode === "patch") {
      const merged = measureTree(tmpDir);
      const overflow =
        merged.bytes > config.JOTS_MAX_BYTES ? "TOO_LARGE" : merged.files > config.JOTS_MAX_FILES ? "TOO_MANY_FILES" : null;
      if (overflow) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return reply.code(413).send({ error: overflow });
      }
    }

    // A jot is a site: the root must have an index.html, or `/j/<name>/` 404s.
    // Reject loudly here instead of publishing a jot that serves nothing. A
    // patch normally inherits one from the staged copy of the live tree.
    if (!fs.existsSync(path.join(tmpDir, "index.html"))) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return reply.code(400).send({ error: "NO_INDEX" });
    }

    const result = commitJotDir({
      name: pending.name,
      owner: pending.owner,
      access,
      passwordHash,
      cors,
      srcDir: tmpDir,
    });
    if ("error" in result) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      // name/access were validated at mint (deploy_jot); only DEPLOY_FAILED is expected here.
      const status = result.error === "JOT_NAME_TAKEN" ? 409 : 500;
      return reply.code(status).send(result);
    }
    return reply.code(200).send(result);
  });

  // Preflight, only for jots that opted into cross-origin reads. Anything else
  // 404s so a jot's CORS posture isn't discoverable by probing.
  app.options<{ Params: { name: string; "*": string } }>("/j/:name/*", async (req, reply) => {
    const { name } = req.params;
    if (!isValidJotName(name)) return reply.code(404).send("Not found");
    const manifest = readManifest(name);
    if (!corsEnabled(manifest)) return reply.code(404).send("Not found");
    return reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", CORS_METHODS)
      .header("access-control-max-age", "600")
      .code(204)
      .send();
  });

  app.get<{ Params: { name: string; "*": string } }>("/j/:name/*", async (req, reply) => {
    const { name } = req.params;
    const rest = req.params["*"] ?? "";
    if (!isValidJotName(name)) return reply.code(404).send("Not found");

    const manifest = readManifest(name);
    if (!manifest) return reply.code(404).send("Not found");

    if (manifest.access === "password") {
      const cookies = parseCookies(req.headers["cookie"]);
      const ok = verifyToken(secret(), name, manifest.hash ?? "", cookies[cookieName(name)]);
      if (!ok) {
        if (wantsHtml(req)) {
          setJotSecurityHeaders(reply, null);
          return reply.code(200).type("text/html; charset=utf-8").send(unlockPage(name, false));
        }
        return reply.code(401).send("Unauthorized");
      }
    }

    // Block manifest explicitly (404, not 403 — we don't reveal it exists).
    if (path.basename(rest).toLowerCase() === MANIFEST) return reply.code(404).send("Not found");

    const jotDir = path.join(jotsRoot(), name);
    const filePath = resolveInside(jotDir, rest);
    if (!filePath) return reply.code(403).send("Forbidden");

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return reply.code(404).send("Not found");
    }
    if (stat.isDirectory()) {
      const idx = path.join(filePath, "index.html");
      if (!fs.existsSync(idx)) return reply.code(404).send("Not found");
      return streamFile(reply, idx, manifest);
    }
    return streamFile(reply, filePath, manifest);
  });
}
