import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";

// Space upload tokens. Same design as jots/pending.ts (see
// docs/findings/2026-09-13-stateless-jot-upload-token.md): a row in the generic
// short-TTL `pending_auth` table under its own sentinel, so a token survives a
// restart and works on every worker, and single use is arbitrated by the
// DELETE. Every read and delete is scoped to the sentinel.
export const SPACE_UPLOAD_SENTINEL = "__space_upload__";

export interface PendingSpaceUpload {
  owner: string;
  name: string;
  // "replace" publishes the archive as the whole Space; "patch" overlays it
  // onto the live tree after removing `deletes`.
  mode: "replace" | "patch";
  deletes?: string[];
  expiresAt: number;
}

interface StoredPayload {
  name: string;
  mode: "replace" | "patch";
  deletes?: string[];
}

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export async function mint(input: {
  owner: string;
  name: string;
  mode?: "replace" | "patch";
  deletes?: string[];
}): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now() + config.JOTS_UPLOAD_TTL_SECONDS * 1000;
  const payload: StoredPayload = { name: input.name, mode: input.mode ?? "replace", deletes: input.deletes };
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [token, input.owner, SPACE_UPLOAD_SENTINEL, Math.ceil(expiresAt / 1000), JSON.stringify(payload)]
  );
  return { token, expiresAt };
}

// Single use, enforced by the database. Null for an unknown, expired or spent token.
export async function consume(token: string): Promise<PendingSpaceUpload | null> {
  if (typeof token !== "string" || token === "") return null;
  const row = await db.get<{ user_id: string; session_data: string | null; expires_at: number }>(
    "SELECT user_id, session_data, expires_at FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, SPACE_UPLOAD_SENTINEL, Math.floor(now() / 1000)]
  );
  if (!row) return null;

  // The DELETE, not the SELECT, makes this single use: of two concurrent
  // uploads exactly one sees a row removed.
  const { changes } = await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [
    token,
    SPACE_UPLOAD_SENTINEL,
  ]);
  if (changes !== 1) return null;

  let payload: StoredPayload;
  try {
    payload = JSON.parse(row.session_data ?? "") as StoredPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload.name !== "string") return null;
  if (payload.mode !== "replace" && payload.mode !== "patch") return null;
  return {
    owner: row.user_id,
    name: payload.name,
    mode: payload.mode,
    deletes: Array.isArray(payload.deletes) ? payload.deletes : undefined,
    expiresAt: Number(row.expires_at) * 1000,
  };
}

export async function reapExpired(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration = ? AND expires_at < ?", [
    SPACE_UPLOAD_SENTINEL,
    Math.floor(now() / 1000),
  ]);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startSpaceUploadReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapExpired().catch((e) => console.warn("[spaces] upload reaper failed:", e));
  }, intervalMs);
  timer.unref?.();
}
export function stopSpaceUploadReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
