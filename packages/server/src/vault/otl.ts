import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { isValidVaultName, VaultError, VAULT_MAX_VALUE_BYTES } from "./store";
import { encrypt, decrypt } from "../auth/encryption";

// One-time links for vault values, on `pending_auth` under a sentinel —
// the same pattern as workspace/presign.ts and jots/pending.ts
// (docs/findings/2026-09-13-stateless-jot-upload-token.md).
//
// Two kinds of link share the sentinel, told apart by `session_data`:
//
//  - named  `{ name }`   — a link to a stored secret. The row holds the NAME,
//    never the value; the route decrypts it at redeem time from the row's own
//    user_id, so nothing off the request decides whose secret is read.
//  - ad hoc `{ adhoc }`  — a one-time secret minted from the portal that is
//    never stored in user_vaults. The row carries the value itself, under the
//    same AES-256-GCM envelope as a vault row (auth/encryption.ts), base64 in
//    the TEXT column. It is decrypted once, by consumeOtl, and the DELETE that
//    makes the redeem single-use also destroys the only ciphertext. The reaper
//    destroys it if nobody redeems in time.
//
// Single use is arbitrated by the DELETE (`changes === 1`), not the SELECT:
// concurrent redeems all read the row, the database serialises the deletes,
// exactly one wins. Atomic on both backends, no transaction.

export const OTL_SENTINEL = "__vault_otl__";
export const OTL_DEFAULT_TTL_SECONDS = 120;
export const OTL_MAX_TTL_SECONDS = 600;

export interface MintedOtl {
  token: string;
  url: string;
  expiresAt: number;
}

/** Result of a redeem: a stored secret to read, or an ad hoc value already in hand. */
export type OtlGrant =
  | { userId: string; name: string; value?: undefined }
  | { userId: string; value: string; name?: undefined };

function clampTtl(ttlSeconds: number): number {
  return Math.min(Math.max(1, Math.floor(ttlSeconds)), OTL_MAX_TTL_SECONDS);
}

async function insertOtl(userId: string, ttlSeconds: number, sessionData: string): Promise<MintedOtl> {
  const ttl = clampTtl(ttlSeconds);
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = now() + ttl * 1000;
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [token, userId, OTL_SENTINEL, Math.ceil(expiresAt / 1000), sessionData]
  );
  return { token, url: otlUrl(token), expiresAt };
}

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export function otlUrl(token: string): string {
  return `${config.SERVER_PUBLIC_URL}/api/vault/otl/${token}`;
}

export async function mintOtl(
  userId: string,
  name: string,
  ttlSeconds: number = OTL_DEFAULT_TTL_SECONDS
): Promise<MintedOtl> {
  if (!isValidVaultName(name)) throw new VaultError("INVALID_NAME");
  const exists = await db.get("SELECT 1 AS one FROM user_vaults WHERE user_id = ? AND name = ?", [
    userId,
    name,
  ]);
  if (!exists) throw new VaultError("NOT_FOUND");
  return insertOtl(userId, ttlSeconds, JSON.stringify({ name }));
}

/**
 * Mint a one-time link for a value that is NOT in the vault. Same size rules
 * as a vault row; the value lives only in the pending_auth row, encrypted.
 */
export async function mintAdhocOtl(
  userId: string,
  value: string,
  ttlSeconds: number = OTL_DEFAULT_TTL_SECONDS
): Promise<MintedOtl> {
  if (typeof value !== "string" || value === "") throw new VaultError("EMPTY_VALUE");
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) throw new VaultError("TOO_LARGE");
  return insertOtl(userId, ttlSeconds, JSON.stringify({ adhoc: encrypt(value).toString("base64") }));
}

export async function consumeOtl(token: string): Promise<OtlGrant | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const row = await db.get<{ user_id: string; session_data: string | null }>(
    "SELECT user_id, session_data FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, OTL_SENTINEL, Math.floor(now() / 1000)]
  );
  if (!row) return null;
  let data: { name?: unknown; adhoc?: unknown };
  try {
    data = JSON.parse(row.session_data ?? "") as { name?: unknown; adhoc?: unknown };
  } catch {
    return null;
  }
  const named = isValidVaultName(data.name);
  const adhoc = typeof data.adhoc === "string" && data.adhoc !== "";
  if (named === adhoc) return null; // exactly one kind, or the row is not ours
  const { changes } = await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [
    token,
    OTL_SENTINEL,
  ]);
  if (changes !== 1) return null;
  if (named) return { userId: row.user_id, name: data.name as string };
  // The row is already gone: a value that fails to decrypt (key rotated) is
  // lost either way, and must not surface as a 500 with a spent token.
  try {
    return { userId: row.user_id, value: decrypt(Buffer.from(data.adhoc as string, "base64")) };
  } catch {
    return null;
  }
}

export async function revokeFor(userId: string, name: string): Promise<void> {
  await db.run(
    "DELETE FROM pending_auth WHERE user_id = ? AND integration = ? AND session_data = ?",
    [userId, OTL_SENTINEL, JSON.stringify({ name })]
  );
}

export async function reapExpiredOtl(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration = ? AND expires_at < ?", [
    OTL_SENTINEL,
    Math.floor(now() / 1000),
  ]);
}

// In-process, like jots' upload reaper: these are DB rows, not a shared disk,
// so N pods sweeping is harmless, and the reap CLI must stay free of ../config.
let timer: NodeJS.Timeout | null = null;
export function startVaultReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapExpiredOtl().catch((e) => console.warn("[vault] otl reaper failed:", e));
  }, intervalMs);
  timer.unref?.();
}
export function stopVaultReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
