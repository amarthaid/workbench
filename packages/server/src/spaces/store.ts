import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import type { DbExecutor } from "../db-adapter";
import { closeOpenForSubject } from "../approvals/store";
import { config } from "../config";
import { isValidJotName } from "../jots/paths";
import { spacesRoot } from "./dir";

// Space metadata lives in the database (spaces, space_shares, space_consents,
// space_kv); the author's files live on disk under spacesRoot()/<name>/.
// Times are epoch milliseconds. PostgreSQL stores them as BIGINT, which node-pg
// hands back as a string, so every read goes through Number().

export type Visibility = "private" | "org" | "users";
export const VISIBILITIES: readonly Visibility[] = ["private", "org", "users"];

// Whose connections a Space's tool calls run with: the viewer's own (default)
// or the owner's ("delegated access", turned on by the owner in the portal).
export type AccessMode = "viewer" | "owner";
export const ACCESS_MODES: readonly AccessMode[] = ["viewer", "owner"];

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
  accessMode: AccessMode;
  // toolsHash(tools) when the owner turned delegation on or last re-confirmed
  // it; null otherwise. A different current hash suspends delegation. A later
  // deploy that restores exactly the confirmed list resumes it without a new
  // confirm: that is the list the owner approved, so this is intended.
  delegatedToolsHash: string | null;
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
  access_mode: string | null;
  delegated_tools_hash: string | null;
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
    // Anything unrecognised fails closed to the viewer's own access.
    accessMode: r.access_mode === "owner" ? "owner" : "viewer",
    delegatedToolsHash: r.delegated_tools_hash ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const COLUMNS =
  "name, owner_id, title, description, tools, visibility, access_mode, delegated_tools_hash, created_at, updated_at";

/** Delegation is on but the tool list changed since the owner confirmed it. */
export function delegationSuspended(s: Space): boolean {
  return s.accessMode === "owner" && s.delegatedToolsHash !== toolsHash(s.tools);
}

export async function getSpace(name: string): Promise<Space | null> {
  if (!isValidSpaceName(name)) return null;
  const row = await db.get<SpaceRow>(`SELECT ${COLUMNS} FROM spaces WHERE name = ?`, [name]);
  return row ? fromRow(row) : null;
}

/**
 * Create a Space, or replace the metadata of one `ownerId` already owns.
 * `result` is "taken" when another user owns the name. The owner check rides
 * on the upsert itself, so two users racing for a new name cannot both win.
 *
 * Access mode: a new Space is always viewer mode. On a redeploy, private or an
 * explicit `accessMode: "viewer"` resets it to viewer and clears the tool pin;
 * otherwise the stored mode and pin are kept. `accessMode` only accepts
 * "viewer": this is the agent path (deploy_space), and an agent never turns
 * delegation on. Only the owner in the portal does, through updateSpaceMeta.
 *
 * `modeReset` is true when the stored row went from owner to viewer. It is
 * advisory: the previous mode is read without a row lock, so under PostgreSQL
 * READ COMMITTED a concurrent change between that read and the upsert can make
 * it wrong. The stored mode itself is always decided in SQL.
 */
export async function upsertSpace(input: {
  name: string;
  ownerId: string;
  title: string;
  description?: string | null;
  tools: readonly string[];
  visibility: Visibility;
  accessMode?: "viewer";
}): Promise<{ result: "ok" | "taken"; modeReset: boolean }> {
  const t = now();
  // 1: a redeploy resets the mode to viewer and clears the pin; 0: keep both.
  const resetToViewer = input.visibility === "private" || input.accessMode === "viewer" ? 1 : 0;
  return db.transaction(async (tx) => {
    const prev = await tx.get<{ owner_id: string; access_mode: string | null }>(
      "SELECT owner_id, access_mode FROM spaces WHERE name = ?",
      [input.name]
    );
    const row = await tx.get<{ access_mode: string }>(
      `INSERT INTO spaces (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'viewer', NULL, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         tools = excluded.tools,
         visibility = excluded.visibility,
         access_mode = CASE WHEN ? = 1 THEN 'viewer' ELSE spaces.access_mode END,
         delegated_tools_hash = CASE WHEN ? = 1 THEN NULL ELSE spaces.delegated_tools_hash END,
         updated_at = excluded.updated_at
       WHERE spaces.owner_id = excluded.owner_id
       RETURNING access_mode`,
      [
        // VALUES
        input.name,
        input.ownerId,
        input.title,
        input.description ?? null,
        JSON.stringify(normalizeTools(input.tools)),
        input.visibility,
        t, // created_at
        t, // updated_at
        // ON CONFLICT: the same flag for access_mode, then delegated_tools_hash
        resetToViewer,
        resetToViewer,
      ]
    );
    if (!row) return { result: "taken" as const, modeReset: false };
    const modeReset =
      prev?.owner_id === input.ownerId && prev.access_mode === "owner" && row.access_mode !== "owner";
    return { result: "ok" as const, modeReset };
  });
}

export interface SpaceMetaPatch {
  title?: string;
  description?: string | null;
  tools?: readonly string[];
  visibility?: Visibility;
  accessMode?: AccessMode;
  // With accessMode "owner": record the tool list as the confirmed one (turn
  // delegation on, or re-confirm it after a tool change). Without it, "owner"
  // changes nothing.
  confirmDelegation?: boolean;
  // Required with confirmDelegation: toolsHash of the list the owner reviewed.
  expectedToolsHash?: string;
}

export type SpaceMetaResult = { space: Space; modeReset: boolean } | "tools_changed" | "conflict" | null;

/** The stored fields updateSpaceMeta read and may rewrite, as raw column values. */
export type SpaceMetaSnapshot = Pick<
  SpaceRow,
  "title" | "description" | "tools" | "visibility" | "access_mode" | "delegated_tools_hash"
>;

/**
 * Apply a partial metadata change as `ownerId`. Unset fields keep their value.
 *
 * - null: the Space is missing or owned by another user (also when it was
 *   deleted and re-created by someone else before the write).
 * - "conflict": the owner's row changed between this function's read and its
 *   write (a concurrent redeploy, sharing change or confirm). The write is a
 *   compare-and-set on every field it rewrites, so the other change is never
 *   undone; nothing is written and the caller should ask to retry.
 * - "tools_changed": `confirmDelegation` without `expectedToolsHash`, or with
 *   one that is not the hash of both the stored list and the resulting list.
 *   The owner confirmed a list that is not the one being pinned; nothing is
 *   written.
 * - otherwise the new Space, and `modeReset`: true when the row went from
 *   owner to viewer, for any cause (private audience or an explicit switch).
 *
 * Whether the owner may turn delegation on is the caller's check.
 */
export async function updateSpaceMeta(name: string, ownerId: string, patch: SpaceMetaPatch): Promise<SpaceMetaResult> {
  if (!isValidSpaceName(name)) return null;
  const row = await db.get<SpaceRow>(`SELECT ${COLUMNS} FROM spaces WHERE name = ?`, [name]);
  if (!row) return null;
  const cur = fromRow(row);
  if (cur.ownerId !== ownerId) return null;
  const next: Space = {
    ...cur,
    title: patch.title ?? cur.title,
    description: patch.description === undefined ? cur.description : patch.description,
    tools: patch.tools ? normalizeTools(patch.tools) : cur.tools,
    visibility: patch.visibility ?? cur.visibility,
    updatedAt: cur.updatedAt,
  };
  // updated_at is "the Space itself changed": a new tool list counts, a new
  // title, description or audience does not (see the note on OPENERS_FLOOR).
  if (toolsHash(next.tools) !== toolsHash(cur.tools)) next.updatedAt = now();
  if (patch.confirmDelegation) {
    const expected = patch.expectedToolsHash;
    if (!expected || expected !== toolsHash(cur.tools) || expected !== toolsHash(next.tools)) return "tools_changed";
  }
  if (next.visibility === "private") {
    next.accessMode = "viewer";
    next.delegatedToolsHash = null;
  } else if (patch.accessMode === "owner" && patch.confirmDelegation) {
    next.accessMode = "owner";
    next.delegatedToolsHash = toolsHash(next.tools);
  } else if (patch.accessMode === "viewer") {
    next.accessMode = "viewer";
    next.delegatedToolsHash = null;
  }
  if (!(await writeSpaceMetaIfUnchanged(next, row))) {
    // Still ours: someone changed it meanwhile. Gone or someone else's: null.
    const owner = await db.get<{ owner_id: string }>("SELECT owner_id FROM spaces WHERE name = ?", [name]);
    return owner?.owner_id === ownerId ? "conflict" : null;
  }
  return { space: next, modeReset: cur.accessMode === "owner" && next.accessMode === "viewer" };
}

/**
 * Write `next`'s metadata only if the row is still owned by `next.ownerId` and
 * every field this write replaces still holds the value in `read` (the raw
 * columns as read). Nullable columns compare through COALESCE, which is
 * portable to both backends. Exported so the compare-and-set can be tested
 * with a stale read.
 */
export async function writeSpaceMetaIfUnchanged(next: Space, read: SpaceMetaSnapshot): Promise<boolean> {
  const { changes } = await db.run(
    `UPDATE spaces SET title = ?, description = ?, tools = ?, visibility = ?, access_mode = ?, delegated_tools_hash = ?,
       updated_at = ?
     WHERE name = ? AND owner_id = ?
       AND title = ? AND COALESCE(description, '') = ? AND tools = ? AND visibility = ?
       AND access_mode = ? AND COALESCE(delegated_tools_hash, '') = ?`,
    [
      // SET
      next.title,
      next.description,
      JSON.stringify(next.tools),
      next.visibility,
      next.accessMode,
      next.delegatedToolsHash,
      next.updatedAt,
      // WHERE: the row, then each field as read
      next.name,
      next.ownerId,
      read.title,
      read.description ?? "",
      read.tools,
      read.visibility,
      read.access_mode ?? "viewer",
      read.delegated_tools_hash ?? "",
    ]
  );
  return changes === 1;
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

/** How many of `ownerId`'s Spaces run with the owner's access (suspended ones included). */
export async function countDelegatedSpaces(ownerId: string): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM spaces WHERE owner_id = ? AND access_mode = 'owner'",
    [ownerId]
  );
  return Number(row?.n ?? 0);
}

export async function listAllSpaces(): Promise<Array<Space & { ownerEmail: string | null }>> {
  const rows = await db.all<SpaceRow & { owner_email: string | null }>(
    `SELECT s.name, s.owner_id, s.title, s.description, s.tools, s.visibility, s.access_mode, s.delegated_tools_hash,
            s.created_at, s.updated_at,
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

export type EmailCheck = { ok: true; emails: string[] } | { ok: false; error: "INVALID_USERS"; message: string };

/** Validate and normalise a share list input: lowercased, deduplicated, each one an email. */
export function parseEmails(users: unknown): EmailCheck {
  if (!Array.isArray(users) || users.some((u) => typeof u !== "string")) {
    return { ok: false, error: "INVALID_USERS", message: "users must be an array of email addresses" };
  }
  const emails = Array.from(new Set((users as string[]).map(normalizeEmail)));
  for (const e of emails) {
    if (!/^[^\s@]+@[^\s@]+$/.test(e)) return { ok: false, error: "INVALID_USERS", message: `Not an email address: ${e}` };
  }
  return { ok: true, emails };
}

export type ShareChange = string[] | "forbidden" | "empty";

/**
 * Add and/or remove emails from the share list as `ownerId`, leaving every
 * other share alone. Removals apply after additions, so an email in both ends
 * up removed. One transaction with the owner check, so two concurrent edits
 * each keep the other's change, which a read-merge-`setShares` cannot promise.
 *
 * `requireNonEmpty` (a Space with visibility 'users') refuses a change that
 * would leave nobody on the list: "empty", and nothing is written. Returns the
 * resulting list, or "forbidden" when the Space is missing or someone else's.
 *
 * `executor`: pass the transaction you are already in (an approval being
 * applied). The function then opens no transaction of its own, which would
 * queue behind yours on SQLite (a hang) and commit separately on PostgreSQL.
 * Because the caller owns the transaction, an "empty" answer has already
 * written the change: the caller must roll back (or not pass `requireNonEmpty`).
 */
export async function changeShares(
  name: string,
  ownerId: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
  requireNonEmpty = false,
  executor?: DbExecutor
): Promise<ShareChange> {
  const norm = (list?: readonly string[]) =>
    Array.from(new Set((list ?? []).map(normalizeEmail).filter((e) => e !== "")));
  const add = norm(change.add);
  const remove = norm(change.remove);
  const body = async (tx: DbExecutor): Promise<ShareChange> => {
    const row = await tx.get<{ owner_id: string }>("SELECT owner_id FROM spaces WHERE name = ?", [name]);
    if (!row || row.owner_id !== ownerId) return "forbidden";
    for (const email of add) {
      await tx.run(
        "INSERT INTO space_shares (space_name, email) VALUES (?, ?) ON CONFLICT (space_name, email) DO NOTHING",
        [name, email]
      );
    }
    for (const email of remove) {
      await tx.run("DELETE FROM space_shares WHERE space_name = ? AND email = ?", [name, email]);
    }
    const rows = await tx.all<{ email: string }>(
      "SELECT email FROM space_shares WHERE space_name = ? ORDER BY email ASC",
      [name]
    );
    // Throwing rolls the transaction back; the sentinel is caught below.
    if (requireNonEmpty && rows.length === 0) throw new EmptyShares();
    return rows.map((r) => r.email);
  };
  return (executor ? body(executor) : db.transaction(body)).catch((e) => {
    if (e instanceof EmptyShares) return "empty" as const;
    throw e;
  });
}

class EmptyShares extends Error {}

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

/**
 * What `viewerId` approves. A viewer approves the tool list, whose connections
 * the calls run with (access mode) and whose Space it is (owner): a change to
 * any of them re-asks. The owner's own calls always run as the owner, so the
 * mode means nothing to them: only a change to the tool list re-asks, and
 * turning delegation on or off does not.
 */
export function consentHash(space: Space, viewerId: string): string {
  const parts =
    viewerId === space.ownerId
      ? [toolsHash(space.tools), "owner-self"]
      : [toolsHash(space.tools), space.accessMode, space.ownerId];
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** True when this user consented to exactly what consentHash covers for them now. */
export async function hasConsent(space: Space, userId: string): Promise<boolean> {
  return (await getConsentHash(space.name, userId)) === consentHash(space, userId);
}

// The column is still named tools_hash; it holds consentHash(space).
export async function grantConsent(space: Space, userId: string): Promise<void> {
  await db.run(
    `INSERT INTO space_consents (space_name, user_id, tools_hash, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (space_name, user_id) DO UPDATE SET tools_hash = excluded.tools_hash, granted_at = excluded.granted_at`,
    [space.name, userId, consentHash(space, userId), now()]
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
    await tx.run("DELETE FROM space_user_state WHERE space_name = ?", [name]);
    await tx.run("DELETE FROM space_shares WHERE space_name = ?", [name]);
    await tx.run("DELETE FROM spaces WHERE name = ?", [name]);
    // Open access requests for this Space can never be granted now. A Space
    // later created under the same name does not inherit them either (each
    // request also pins the Space's created_at).
    await closeOpenForSubject(tx, "space.access", name, "cancelled", null, "space_deleted");
  });
  if (isValidSpaceName(name)) fs.rmSync(spaceDir(name), { recursive: true, force: true });
}

// ---- per-person state: favorites and last opened -----------------------------
// One row per (Space, person). A favorite orders that person's own gallery and
// is counted on the tile; last_opened_at drives their "recently opened" order,
// the "new for you" mark and, for the owner, how many people have used it.

/** Mark or unmark `name` as a favorite of `userId`. Idempotent either way. */
export async function setFavorite(name: string, userId: string, on: boolean): Promise<void> {
  if (on) {
    // COALESCE keeps the first time, so favoriting twice does not move it.
    await db.run(
      `INSERT INTO space_user_state (space_name, user_id, favorited_at, last_opened_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT (space_name, user_id) DO UPDATE SET
         favorited_at = COALESCE(space_user_state.favorited_at, excluded.favorited_at)`,
      [name, userId, now()]
    );
  } else {
    await db.run("UPDATE space_user_state SET favorited_at = NULL WHERE space_name = ? AND user_id = ?", [name, userId]);
  }
}

/** Record that `userId` opened `name` now. Idempotent: it only moves the time forward. */
export async function recordOpen(name: string, userId: string): Promise<void> {
  await db.run(
    `INSERT INTO space_user_state (space_name, user_id, favorited_at, last_opened_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT (space_name, user_id) DO UPDATE SET last_opened_at = excluded.last_opened_at`,
    [name, userId, now()]
  );
}

export interface UserSpaceState {
  favorited: boolean;
  /** Epoch ms, null when never opened. */
  lastOpenedAt: number | null;
}

/** `userId`'s state for every Space they have a row for. */
export async function userSpaceStates(userId: string): Promise<Map<string, UserSpaceState>> {
  const rows = await db.all<{ space_name: string; favorited_at: number | string | null; last_opened_at: number | string | null }>(
    "SELECT space_name, favorited_at, last_opened_at FROM space_user_state WHERE user_id = ?",
    [userId]
  );
  return new Map(
    rows.map((r) => [
      r.space_name,
      {
        favorited: r.favorited_at !== null,
        lastOpenedAt: r.last_opened_at === null ? null : Number(r.last_opened_at),
      },
    ])
  );
}

// Who still counts for a Space: its owner, anyone when it is open to everyone
// signed in, and for a shared one only the people still on the list (matched by
// the lowercased email, which is how shares are stored). Someone removed from
// the list stops counting but keeps their row, so re-sharing brings it back.
const STILL_COUNTS = `(
  s.visibility = 'org'
  OR st.user_id = s.owner_id
  OR (s.visibility = 'users' AND EXISTS (
    SELECT 1 FROM space_shares sh JOIN users u ON LOWER(u.email) = sh.email
    WHERE sh.space_name = s.name AND u.id = st.user_id))
)`;

/**
 * How many people have favorited each Space (absent means none), over people
 * who can still open it. A private Space is left out: the only person who can
 * have favorited it is its owner. Pass `name` for one Space.
 */
export async function favoriteCounts(name?: string): Promise<Map<string, number>> {
  const rows = await db.all<{ space_name: string; n: number | string }>(
    `SELECT st.space_name AS space_name, COUNT(*) AS n
       FROM space_user_state st JOIN spaces s ON s.name = st.space_name
      WHERE st.favorited_at IS NOT NULL AND s.visibility <> 'private' AND ${STILL_COUNTS}
        ${name === undefined ? "" : "AND st.space_name = ?"}
      GROUP BY st.space_name`,
    name === undefined ? [] : [name]
  );
  return new Map(rows.map((r) => [r.space_name, Number(r.n)]));
}

/**
 * How many people other than the owner opened each of `ownerId`'s Spaces since
 * `sinceMs`, over people who can still open it. One count per person however
 * often they opened it, so reloads and a heavy user do not inflate it.
 */
export async function distinctOpeners(ownerId: string, sinceMs: number): Promise<Map<string, number>> {
  const rows = await db.all<{ space_name: string; n: number | string }>(
    `SELECT st.space_name AS space_name, COUNT(*) AS n
       FROM space_user_state st JOIN spaces s ON s.name = st.space_name
      WHERE s.owner_id = ? AND st.user_id <> s.owner_id AND st.last_opened_at >= ? AND ${STILL_COUNTS}
      GROUP BY st.space_name`,
    [ownerId, sinceMs]
  );
  return new Map(rows.map((r) => [r.space_name, Number(r.n)]));
}

/**
 * An owner is shown the number of people who opened a Space only when it
 * cannot point at individuals: it is open to everyone signed in, or enough
 * people opened it. On a Space shared with three, "2 opened it" is "who".
 */
export const OPENERS_FLOOR = 5;

// A portal edit of the title, description or audience is not an update to the
// Space itself, so it must not move updated_at (that is what "updated since you
// last opened" reads). Changing the tool list does.
