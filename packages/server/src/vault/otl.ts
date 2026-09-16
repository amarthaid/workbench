import crypto from "node:crypto";
import { db } from "../db";
import { config } from "../config";
import { isValidVaultName, VaultError } from "./store";

// One-time links for vault values, on `pending_auth` under a sentinel —
// the same pattern as workspace/presign.ts and jots/pending.ts
// (docs/findings/2026-09-13-stateless-jot-upload-token.md).
//
// The row holds the secret's NAME, never its value. The value is decrypted at
// redeem time by the route, from the row's own user_id — nothing off the
// request decides whose secret is read.
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
  const ttl = Math.min(Math.max(1, Math.floor(ttlSeconds)), OTL_MAX_TTL_SECONDS);
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = now() + ttl * 1000;
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [token, userId, OTL_SENTINEL, Math.ceil(expiresAt / 1000), JSON.stringify({ name })]
  );
  return { token, url: otlUrl(token), expiresAt };
}

export async function consumeOtl(token: string): Promise<{ userId: string; name: string } | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return null;
  const row = await db.get<{ user_id: string; session_data: string | null }>(
    "SELECT user_id, session_data FROM pending_auth WHERE state = ? AND integration = ? AND expires_at > ?",
    [token, OTL_SENTINEL, Math.floor(now() / 1000)]
  );
  if (!row) return null;
  let name: unknown;
  try {
    name = (JSON.parse(row.session_data ?? "") as { name?: unknown }).name;
  } catch {
    return null;
  }
  if (!isValidVaultName(name)) return null;
  const { changes } = await db.run("DELETE FROM pending_auth WHERE state = ? AND integration = ?", [
    token,
    OTL_SENTINEL,
  ]);
  if (changes !== 1) return null;
  return { userId: row.user_id, name };
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
