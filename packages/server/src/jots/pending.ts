import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";

export interface PendingDeploy {
  owner: string;
  name: string;
  // "replace" publishes the archive as the whole jot; "patch" overlays it onto
  // the live tree. A patch token carries no access/passwordHash — those are
  // read from the live manifest at commit, so a patch can never change gating.
  mode: "replace" | "patch";
  access?: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
  deletes?: string[];
  expiresAt: number;
}

// `mode` is optional at the call site and defaults to "replace" so existing
// deploy callers are unaffected.
export type MintInput = Omit<PendingDeploy, "expiresAt" | "mode"> & {
  mode?: "replace" | "patch";
};

// Pending deploys live in `pending_auth` under a sentinel `integration`, the
// same way the MCP /authorize ticket does (auth/oauth-server/resume.ts).
//
// Despite the name, pending_auth is the server's general short-TTL handshake
// table rather than an OAuth-only one: four generic columns (state, user_id,
// integration, expires_at) plus nullable per-flow extras, with `integration`
// as the discriminator. A jot upload is not auth, but it is exactly that shape
// — a single-use ticket that expires in minutes — and riding the table means
// the token survives a restart and is visible to every worker and replica,
// which a process-local Map never was.
//
// EVERY read and delete here is scoped to the sentinel, so this flow can
// neither see nor consume an SSO or plugin-OAuth row.
const SENTINEL = "__jot_upload__";

/** The per-flow payload stored in `session_data`. */
interface StoredPayload {
  name: string;
  mode: "replace" | "patch";
  access?: "public" | "password";
  passwordHash?: string;
  cors?: boolean;
  deletes?: string[];
}

// Clock seam: overridable in tests so TTL expiry is testable without sleeping.
let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export async function mint(input: MintInput): Promise<{ token: string; expiresAt: number }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now() + config.JOTS_UPLOAD_TTL_SECONDS * 1000;
  const payload: StoredPayload = {
    name: input.name,
    mode: input.mode ?? "replace",
    access: input.access,
    passwordHash: input.passwordHash,
    cors: input.cors,
    deletes: input.deletes,
  };
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [
      token,
      input.owner,
      SENTINEL,
      // The column is whole seconds; round up so the row never dies marginally
      // before the millisecond `expiresAt` handed back to the caller.
      Math.ceil(expiresAt / 1000),
      JSON.stringify(payload),
    ]
  );
  return { token, expiresAt };
}

// Single use, enforced by the database rather than by process memory. Returns
// null for a token that is unknown, expired, or already consumed anywhere.
export async function consume(token: string): Promise<PendingDeploy | null> {
  if (typeof token !== "string" || token === "") return null;

  const row = await db.get<{ user_id: string; session_data: string | null; expires_at: number }>(
    "SELECT user_id, session_data, expires_at FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, SENTINEL, Math.floor(now() / 1000)]
  );
  if (!row) return null;

  // The DELETE, not the SELECT, is what makes this single-use: two concurrent
  // uploads of the same token both read the row, but the database serialises
  // the deletes and exactly one of them reports a row removed. The loser is
  // told the token is spent, which is true.
  const { changes } = await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [
    token,
    SENTINEL,
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
    access: payload.access === "public" || payload.access === "password" ? payload.access : undefined,
    passwordHash: typeof payload.passwordHash === "string" ? payload.passwordHash : undefined,
    cors: payload.cors === true ? true : undefined,
    deletes: Array.isArray(payload.deletes) ? payload.deletes : undefined,
    expiresAt: Number(row.expires_at) * 1000,
  };
}

// Drops abandoned rows once they are past their TTL. Scoped to the sentinel so
// it can never reap another flow's handshake, even an expired one.
export async function reapExpired(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration = ? AND expires_at < ?", [
    SENTINEL,
    Math.floor(now() / 1000),
  ]);
}

// Periodic cleanup of abandoned tokens. Mirrors auth/connections reaper.
let timer: ReturnType<typeof setInterval> | null = null;
export function startUploadReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    // A sweep failure is not worth crashing the process: the rows are already
    // dead to `consume`, and the next tick tries again.
    void reapExpired().catch((e) => console.warn("[jots] upload reaper failed:", e));
  }, intervalMs);
  timer.unref?.();
}
export function stopUploadReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
