import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";

// Presigned workspace URLs ride `pending_auth` under sentinel `integration`
// values, the same way the jot upload ticket and the MCP /authorize ticket do
// (docs/findings/2026-09-13-stateless-jot-upload-token.md). Despite the name it
// is the server's general short-TTL handshake table.
//
// Stateful rather than a self-contained JWS, deliberately. It buys three things
// a signed token cannot: single use that is REAL (the DELETE arbitrates, not a
// per-process guard), revocation, and no owner id in the URL.
//
// EVERY read and delete below is scoped to one of these sentinels, so this flow
// can neither see nor consume an SSO, plugin-OAuth, or jot-upload row.
const DOWNLOAD = "__file_dl__";
const UPLOAD = "__file_ul__";

export type PresignOp = "download" | "upload";

export interface PresignedGrant {
  userId: string;
  name: string;
}

export interface Minted {
  token: string;
  url: string;
  expiresAt: number;
  op: PresignOp;
  name: string;
}

// Clock seam: overridable in tests so TTL expiry is testable without sleeping.
let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

function sentinelFor(op: PresignOp): string {
  return op === "download" ? DOWNLOAD : UPLOAD;
}

export function presignUrl(op: PresignOp, token: string): string {
  return `${config.SERVER_PUBLIC_URL}/api/files/${op === "download" ? "dl" : "ul"}/${token}`;
}

/**
 * Mint a presigned URL.
 *
 * The token is 32 hex characters and opaque — not a JWT. find-my-way caps a
 * route param at 100 characters and answers 414 past it, which is exactly what
 * the jot upload flow hit when its token was a JWS.
 *
 * The filename is stored in the row and is never read back off the request. An
 * upload URL that took a name at redeem time would be a write-anywhere
 * primitive.
 */
export async function mintPresign(
  userId: string,
  name: string,
  op: PresignOp,
  ttlSeconds = config.WORKSPACE_PRESIGN_TTL_SECONDS
): Promise<Minted> {
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = now() + ttlSeconds * 1000;
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [
      token,
      userId,
      sentinelFor(op),
      // The column is whole seconds; round up so the row never dies marginally
      // before the millisecond expiresAt handed back to the caller.
      Math.ceil(expiresAt / 1000),
      JSON.stringify({ name }),
    ]
  );
  return { token, url: presignUrl(op, token), expiresAt, op, name };
}

async function selectGrant(token: string, sentinel: string): Promise<PresignedGrant | null> {
  if (typeof token !== "string" || token === "") return null;
  const row = await db.get<{ user_id: string; session_data: string | null }>(
    "SELECT user_id, session_data FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, sentinel, Math.floor(now() / 1000)]
  );
  if (!row) return null;
  try {
    const payload = JSON.parse(row.session_data ?? "") as { name?: unknown };
    if (typeof payload?.name !== "string") return null;
    return { userId: row.user_id, name: payload.name };
  } catch {
    return null;
  }
}

/**
 * Read a download grant WITHOUT spending it.
 *
 * Multi-use inside its TTL, unlike the jot upload token: a fetch gets retried,
 * and some clients issue HEAD before GET. The short TTL is what bounds it.
 */
export async function peekDownload(token: string): Promise<PresignedGrant | null> {
  return selectGrant(token, DOWNLOAD);
}

/**
 * Spend an upload grant. Exactly once, ever.
 *
 * The DELETE, not the SELECT, is what arbitrates: two concurrent PUTs both read
 * the row, the database serialises the deletes, and exactly one reports a row
 * removed. Atomic on both backends with no transaction. The loser is told the
 * token is spent, which is true.
 */
export async function consumeUpload(token: string): Promise<PresignedGrant | null> {
  const grant = await selectGrant(token, UPLOAD);
  if (!grant) return null;
  const { changes } = await db.run(
    "DELETE FROM pending_auth WHERE state = ? AND integration = ?",
    [token, UPLOAD]
  );
  if (changes !== 1) return null;
  return grant;
}

/** Revoke every outstanding grant for one file — used when the file is deleted. */
export async function revokeFor(userId: string, name: string): Promise<void> {
  const payload = JSON.stringify({ name });
  await db.run(
    "DELETE FROM pending_auth WHERE user_id = ? AND integration IN (?, ?) AND session_data = ?",
    [userId, DOWNLOAD, UPLOAD, payload]
  );
}

/** Drop abandoned rows once past their TTL. Scoped to these sentinels only. */
export async function reapExpiredPresigns(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration IN (?, ?) AND expires_at < ?", [
    DOWNLOAD,
    UPLOAD,
    Math.floor(now() / 1000),
  ]);
}
