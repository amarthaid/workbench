import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { config } from "../config";
import { isValidJotName } from "../jots/paths";
import { spacesRoot } from "./dir";

// Space metadata lives in the database (spaces, space_shares, space_consents,
// space_kv); the author's files live on disk under spacesRoot()/<name>/.
// Times are epoch milliseconds. PostgreSQL stores them as BIGINT, which node-pg
// hands back as a string, so every read goes through Number().

export type Visibility = "private" | "org" | "users";
export const VISIBILITIES: readonly Visibility[] = ["private", "org", "users"];

// Path segments the server itself owns under /s/.
export const RESERVED_SPACE_NAMES: ReadonlySet<string> = new Set(["_sdk", "upload"]);

export const KV_KEY_MAX = 128;
export const KV_VALUE_MAX_BYTES = 64 * 1024;
export const KV_TOTAL_MAX_BYTES = 256 * 1024;

export interface Space {
  name: string;
  ownerId: string;
  title: string;
  description: string | null;
  tools: string[];
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
}

interface SpaceRow {
  name: string;
  owner_id: string;
  title: string;
  description: string | null;
  tools: string;
  visibility: string;
  created_at: number | string;
  updated_at: number | string;
}

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

/** Jot name rules, minus the names reserved for server routes. */
export function isValidSpaceName(name: unknown): name is string {
  return typeof name === "string" && isValidJotName(name) && !RESERVED_SPACE_NAMES.has(name);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Sorted, deduplicated. The stored and hashed form of a tool list. */
export function normalizeTools(tools: readonly string[]): string[] {
  return Array.from(new Set(tools)).sort();
}

/** sha256 of the sorted tool-list JSON: order and duplicates do not change it. */
export function toolsHash(tools: readonly string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(normalizeTools(tools))).digest("hex");
}

function fromRow(r: SpaceRow): Space {
  let tools: string[] = [];
  try {
    const parsed = JSON.parse(r.tools);
    if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    /* malformed: no tools */
  }
  return {
    name: r.name,
    ownerId: r.owner_id,
    title: r.title,
    description: r.description ?? null,
    tools,
    visibility: (VISIBILITIES as readonly string[]).includes(r.visibility) ? (r.visibility as Visibility) : "private",
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const COLUMNS = "name, owner_id, title, description, tools, visibility, created_at, updated_at";

export async function getSpace(name: string): Promise<Space | null> {
  if (!isValidSpaceName(name)) return null;
  const row = await db.get<SpaceRow>(`SELECT ${COLUMNS} FROM spaces WHERE name = ?`, [name]);
  return row ? fromRow(row) : null;
}

/**
 * Create a Space, or replace the metadata of one `ownerId` already owns.
 * Returns "taken" when another user owns the name. The owner check rides on
 * the upsert itself, so two users racing for a new name cannot both win.
 */
export async function upsertSpace(input: {
  name: string;
  ownerId: string;
  title: string;
  description?: string | null;
  tools: readonly string[];
  visibility: Visibility;
}): Promise<"ok" | "taken"> {
  const t = now();
  const { changes } = await db.run(
    `INSERT INTO spaces (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       tools = excluded.tools,
       visibility = excluded.visibility,
       updated_at = excluded.updated_at
     WHERE spaces.owner_id = excluded.owner_id`,
    [
      input.name,
      input.ownerId,
      input.title,
      input.description ?? null,
      JSON.stringify(normalizeTools(input.tools)),
      input.visibility,
      t,
      t,
    ]
  );
  return changes === 1 ? "ok" : "taken";
}

export interface SpaceMetaPatch {
  title?: string;
  description?: string | null;
  tools?: readonly string[];
  visibility?: Visibility;
}

/**
 * Apply a partial metadata change as `ownerId`. Unset fields keep their value.
 * The UPDATE carries the owner predicate, so a Space deleted and re-created by
 * someone else between the caller's check and this write is left alone: null
 * when nothing matched (missing, or owned by another user).
 */
export async function updateSpaceMeta(name: string, ownerId: string, patch: SpaceMetaPatch): Promise<Space | null> {
  const cur = await getSpace(name);
  if (!cur || cur.ownerId !== ownerId) return null;
  const next: Space = {
    ...cur,
    title: patch.title ?? cur.title,
    description: patch.description === undefined ? cur.description : patch.description,
    tools: patch.tools ? normalizeTools(patch.tools) : cur.tools,
    visibility: patch.visibility ?? cur.visibility,
    updatedAt: now(),
  };
  const { changes } = await db.run(
    "UPDATE spaces SET title = ?, description = ?, tools = ?, visibility = ?, updated_at = ? WHERE name = ? AND owner_id = ?",
    [next.title, next.description, JSON.stringify(next.tools), next.visibility, next.updatedAt, name, ownerId]
  );
  return changes === 1 ? next : null;
}

/** Bump updated_at (a new upload landed). */
export async function touchSpace(name: string): Promise<void> {
  await db.run("UPDATE spaces SET updated_at = ? WHERE name = ?", [now(), name]);
}

export async function listOwnedSpaces(ownerId: string): Promise<Space[]> {
  const rows = await db.all<SpaceRow>(
    `SELECT ${COLUMNS} FROM spaces WHERE owner_id = ? ORDER BY updated_at DESC, name ASC`,
    [ownerId]
  );
  return rows.map(fromRow);
}

export async function listAllSpaces(): Promise<Array<Space & { ownerEmail: string | null }>> {
  const rows = await db.all<SpaceRow & { owner_email: string | null }>(
    `SELECT s.name, s.owner_id, s.title, s.description, s.tools, s.visibility, s.created_at, s.updated_at,
            u.email AS owner_email
       FROM spaces s LEFT JOIN users u ON u.id = s.owner_id
      ORDER BY s.updated_at DESC, s.name ASC`
  );
  return rows.map((r) => ({ ...fromRow(r), ownerEmail: r.owner_email ?? null }));
}

export async function ownerEmailOf(ownerId: string): Promise<string | null> {
  const row = await db.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [ownerId]);
  return row?.email ?? null;
}

// ---- shares ----------------------------------------------------------------

export async function getShares(name: string): Promise<string[]> {
  const rows = await db.all<{ email: string }>(
    "SELECT email FROM space_shares WHERE space_name = ? ORDER BY email ASC",
    [name]
  );
  return rows.map((r) => r.email);
}

/**
 * Replace the share list as `ownerId`. Emails are stored lowercased and
 * deduplicated. The owner is confirmed inside the same transaction as the
 * writes; false (and nothing written) when the Space is missing or owned by
 * someone else.
 */
export async function setShares(name: string, ownerId: string, emails: readonly string[]): Promise<boolean> {
  const list = Array.from(new Set(emails.map(normalizeEmail).filter((e) => e !== "")));
  return db.transaction(async (tx) => {
    const row = await tx.get<{ owner_id: string }>("SELECT owner_id FROM spaces WHERE name = ?", [name]);
    if (!row || row.owner_id !== ownerId) return false;
    await tx.run("DELETE FROM space_shares WHERE space_name = ?", [name]);
    for (const email of list) {
      await tx.run("INSERT INTO space_shares (space_name, email) VALUES (?, ?)", [name, email]);
    }
    return true;
  });
}

export async function isSharedWith(name: string, email: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    "SELECT 1 AS n FROM space_shares WHERE space_name = ? AND email = ?",
    [name, normalizeEmail(email)]
  );
  return !!row;
}

// ---- consent ---------------------------------------------------------------

export async function getConsentHash(name: string, userId: string): Promise<string | null> {
  const row = await db.get<{ tools_hash: string }>(
    "SELECT tools_hash FROM space_consents WHERE space_name = ? AND user_id = ?",
    [name, userId]
  );
  return row?.tools_hash ?? null;
}

/** True when the viewer consented to exactly the Space's current tool list. */
export async function hasConsent(space: Space, userId: string): Promise<boolean> {
  return (await getConsentHash(space.name, userId)) === toolsHash(space.tools);
}

export async function grantConsent(space: Space, userId: string): Promise<void> {
  await db.run(
    `INSERT INTO space_consents (space_name, user_id, tools_hash, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (space_name, user_id) DO UPDATE SET tools_hash = excluded.tools_hash, granted_at = excluded.granted_at`,
    [space.name, userId, toolsHash(space.tools), now()]
  );
}

export async function revokeConsent(name: string, userId: string): Promise<void> {
  await db.run("DELETE FROM space_consents WHERE space_name = ? AND user_id = ?", [name, userId]);
}

// ---- per-viewer key-value store ---------------------------------------------

export function isValidKvKey(key: unknown): key is string {
  return typeof key === "string" && key.length >= 1 && key.length <= KV_KEY_MAX;
}

export async function kvKeys(name: string, userId: string): Promise<string[]> {
  const rows = await db.all<{ key: string }>(
    "SELECT key FROM space_kv WHERE space_name = ? AND user_id = ? ORDER BY key ASC",
    [name, userId]
  );
  return rows.map((r) => r.key);
}

/** The stored JSON text, or null when the key is absent. */
export async function kvGet(name: string, userId: string, key: string): Promise<string | null> {
  const row = await db.get<{ value: string }>(
    "SELECT value FROM space_kv WHERE space_name = ? AND user_id = ? AND key = ?",
    [name, userId, key]
  );
  return row ? row.value : null;
}

/**
 * Store `json` (already serialised) under `key`. TOO_LARGE when the value is
 * over 64 KiB or the viewer's total for this Space would pass 256 KiB (keys
 * and values, in UTF-8 bytes). The total is read then written without a lock,
 * so two concurrent writes can overshoot it slightly.
 */
export async function kvPut(name: string, userId: string, key: string, json: string): Promise<"ok" | "TOO_LARGE"> {
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > KV_VALUE_MAX_BYTES) return "TOO_LARGE";
  const rows = await db.all<{ key: string; value: string }>(
    "SELECT key, value FROM space_kv WHERE space_name = ? AND user_id = ?",
    [name, userId]
  );
  let total = Buffer.byteLength(key, "utf8") + bytes;
  for (const r of rows) {
    if (r.key === key) continue;
    total += Buffer.byteLength(r.key, "utf8") + Buffer.byteLength(r.value, "utf8");
  }
  if (total > KV_TOTAL_MAX_BYTES) return "TOO_LARGE";
  await db.run(
    `INSERT INTO space_kv (space_name, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (space_name, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [name, userId, key, json, now()]
  );
  return "ok";
}

export async function kvDelete(name: string, userId: string, key: string): Promise<void> {
  await db.run("DELETE FROM space_kv WHERE space_name = ? AND user_id = ? AND key = ?", [name, userId, key]);
}

// ---- files -----------------------------------------------------------------

export function spaceDir(name: string): string {
  return path.join(spacesRoot(), name);
}

/** A Space is live (visible) once an upload has landed: its root holds index.html. */
export function hasFiles(name: string): boolean {
  if (!isValidSpaceName(name)) return false;
  return fs.existsSync(path.join(spaceDir(name), "index.html"));
}

export interface SpaceFile {
  path: string;
  bytes: number;
  updatedAt: string;
}

/** Every regular file under `dir`, as sorted POSIX paths. */
export function walkFiles(dir: string): SpaceFile[] {
  const files: SpaceFile[] = [];
  const walk = (d: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(d, e.name), rel);
        continue;
      }
      if (!e.isFile()) continue;
      const st = fs.statSync(path.join(d, e.name));
      files.push({ path: rel, bytes: st.size, updatedAt: st.mtime.toISOString() });
    }
  };
  walk(dir, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function listSpaceFiles(name: string): SpaceFile[] {
  return walkFiles(spaceDir(name)).slice(0, config.JOTS_MAX_FILES);
}

/** Delete a Space everywhere: metadata, shares, consents, KV rows, files. */
export async function deleteSpace(name: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM space_kv WHERE space_name = ?", [name]);
    await tx.run("DELETE FROM space_consents WHERE space_name = ?", [name]);
    await tx.run("DELETE FROM space_shares WHERE space_name = ?", [name]);
    await tx.run("DELETE FROM spaces WHERE name = ?", [name]);
  });
  if (isValidSpaceName(name)) fs.rmSync(spaceDir(name), { recursive: true, force: true });
}
