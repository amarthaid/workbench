import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { jotsRoot } from "./dir";
import { isValidJotName, safeRelPath, MANIFEST } from "./paths";

export interface Manifest {
  access: "public" | "password";
  hash?: string;
  // Opt-in cross-origin reads of this jot's files. Only honored for public
  // jots — see setJotSecurityHeaders in routes.ts.
  cors?: boolean;
  owner: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeployFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface DeployInput {
  name: string;
  owner: string;
  access: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
  files: DeployFile[];
}

export type DeployResult = { name: string; access: string; url: string } | { error: string };

function jotDir(name: string): string {
  return path.join(jotsRoot(), name);
}

function jotUrl(name: string): string {
  return `${config.SERVER_PUBLIC_URL}/j/${name}/`;
}

export function readManifest(name: string): Manifest | null {
  try {
    const raw = fs.readFileSync(path.join(jotDir(name), MANIFEST), "utf8");
    const m = JSON.parse(raw) as Manifest;
    if (m && (m.access === "public" || m.access === "password") && typeof m.owner === "string") return m;
  } catch {
    /* missing or malformed → null */
  }
  return null;
}

// Publish an already-prepared directory: write the manifest into it, then
// atomically swap it into place as /jots/<name>/. The directory becomes the
// live jot (renamed, not copied), so it must be on the same filesystem as
// jotsRoot() — callers create it under jotsRoot().
export function commitJotDir(input: {
  name: string;
  owner: string;
  access: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
  srcDir: string;
}): DeployResult {
  const { name, owner, access, passwordHash, cors, srcDir } = input;
  if (!isValidJotName(name)) return { error: "INVALID_NAME" };
  if (access === "password" && !passwordHash) return { error: "PASSWORD_REQUIRED" };

  const existing = readManifest(name);
  if (existing && existing.owner !== owner) return { error: "JOT_NAME_TAKEN" };

  const now = new Date().toISOString();
  const manifest: Manifest = {
    access,
    owner,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(access === "password" ? { hash: passwordHash } : {}),
    ...(cors ? { cors: true } : {}),
  };

  const finalDir = jotDir(name);
  try {
    fs.writeFileSync(path.join(srcDir, MANIFEST), JSON.stringify(manifest, null, 2));
    // Non-atomic on macOS (rename can't replace a non-empty dir → ENOTEMPTY), so
    // drop the old tree first. Brief window where finalDir is absent; acceptable.
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(srcDir, finalDir);
  } catch (e) {
    fs.rmSync(srcDir, { recursive: true, force: true });
    console.error("[commitJotDir] unexpected error:", e);
    return { error: "DEPLOY_FAILED" };
  }
  return { name, access, url: jotUrl(name) };
}

// Decode an inline file array into a tmp dir, then commit it. Retained as a
// test/seed helper; the deploy_jot MCP tool now uses the upload flow instead.
export function deployJot(input: DeployInput): DeployResult {
  const { name, owner, access, passwordHash, cors, files } = input;
  if (!isValidJotName(name)) return { error: "INVALID_NAME" };
  if (access === "password" && !passwordHash) return { error: "PASSWORD_REQUIRED" };
  if (!Array.isArray(files) || files.length === 0) return { error: "NO_FILES" };

  const existing = readManifest(name);
  if (existing && existing.owner !== owner) return { error: "JOT_NAME_TAKEN" };

  fs.mkdirSync(jotsRoot(), { recursive: true });
  const tmpDir = `${jotDir(name)}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let total = 0;
  for (const f of files) {
    const rel = safeRelPath(f.path);
    if (!rel) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { error: "INVALID_PATH" };
    }
    const buf = Buffer.from(f.content ?? "", f.encoding === "base64" ? "base64" : "utf8");
    total += buf.length;
    if (total > config.JOTS_MAX_BYTES) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { error: "TOO_LARGE" };
    }
    const dest = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  return commitJotDir({ name, owner, access, passwordHash, cors, srcDir: tmpDir });
}

export interface JotSummary {
  name: string;
  access: string;
  url: string;
  updatedAt: string;
}

export function listJots(owner: string): JotSummary[] {
  const root = jotsRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: JotSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // Skip in-flight staging dirs: `.tmp-` (deployJot wrapper) and `.up-` (upload route).
    if (e.name.includes(".tmp-") || e.name.includes(".up-")) continue;
    const m = readManifest(e.name);
    if (!m || m.owner !== owner) continue;
    out.push({ name: e.name, access: m.access, url: jotUrl(e.name), updatedAt: m.updatedAt });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

export function deleteJot(name: string, owner: string): { ok: true } | { error: string } {
  const m = readManifest(name);
  if (!m) return { error: "NOT_FOUND" };
  if (m.owner !== owner) return { error: "FORBIDDEN" };
  fs.rmSync(jotDir(name), { recursive: true, force: true });
  return { ok: true };
}

export interface JotFile {
  path: string;
  bytes: number;
  updatedAt: string;
}

// Walk a jot's tree so an agent can see what is there before patching it.
// Owner-scoped like listJots; the manifest is never reported.
export function listJotFiles(name: string, owner: string): { files: JotFile[] } | { error: string } {
  if (!isValidJotName(name)) return { error: "INVALID_NAME" };
  const m = readManifest(name);
  if (!m) return { error: "NOT_FOUND" };
  if (m.owner !== owner) return { error: "FORBIDDEN" };

  const root = jotDir(name);
  const files: JotFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (rel === MANIFEST) continue;
      const st = fs.statSync(path.join(dir, e.name));
      files.push({ path: rel, bytes: st.size, updatedAt: st.mtime.toISOString() });
    }
  };
  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.slice(0, config.JOTS_MAX_FILES) };
}

export interface JotMetaPatch {
  access?: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
}

export type UpdateMetaResult =
  | { name: string; access: "public" | "password"; cors: boolean; url: string }
  | { error: string };

// Change a live jot's gating without touching its files: rewrite the manifest
// alone (tmp file + rename onto it, same filesystem). Flipping public/password,
// rotating a password, or toggling cors used to mean re-uploading the whole
// tree through deploy_jot; this is the cheap path.
//
// Unset fields are inherited from the live manifest, so a caller can change one
// thing without restating the rest. Going public drops the hash — which also
// invalidates every outstanding unlock cookie, since those are HMACs over it
// (see auth.ts) — and staying on password without a new hash keeps the old one.
export function updateJotMeta(name: string, owner: string, patch: JotMetaPatch): UpdateMetaResult {
  if (!isValidJotName(name)) return { error: "INVALID_NAME" };
  const existing = readManifest(name);
  if (!existing) return { error: "NOT_FOUND" };
  if (existing.owner !== owner) return { error: "FORBIDDEN" };

  const access = patch.access ?? existing.access;
  const hash = access === "password" ? patch.passwordHash ?? existing.hash : undefined;
  if (access === "password" && !hash) return { error: "PASSWORD_REQUIRED" };
  const cors = patch.cors ?? existing.cors === true;

  const manifest: Manifest = {
    access,
    owner: existing.owner,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
    ...(access === "password" ? { hash } : {}),
    ...(cors ? { cors: true } : {}),
  };

  // Stage outside the jot dir: a half-written manifest inside it would be a
  // servable file holding the password hash. `.tmp-` also keeps it out of
  // listJots. Same parent dir as the jot, so the rename is atomic.
  const tmpFile = path.join(jotsRoot(), `${name}.tmp-meta-${crypto.randomBytes(4).toString("hex")}`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmpFile, path.join(jotDir(name), MANIFEST));
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    console.error("[updateJotMeta] unexpected error:", e);
    return { error: "UPDATE_FAILED" };
  }
  return { name, access, cors, url: jotUrl(name) };
}
