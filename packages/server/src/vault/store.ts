import crypto from "node:crypto";
import { db } from "../db";
import { encrypt, decrypt } from "../auth/encryption";

// Per-user secrets the agent can USE but never READ.
//
// `readSecretValue` is the only function in the server that decrypts a vault
// row. Its two callers are the interpolator (mcp/meta-tools.ts via
// vault/interpolate.ts) and the one-time-link redeemer (vault/routes.ts). No
// list, no portal route, no tool returns the plaintext.
//
// Same envelope as OAuth tokens: AES-256-GCM under ENCRYPTION_KEY
// (auth/encryption.ts). No key versioning — nothing else has it either.

export type VaultErrorCode = "INVALID_NAME" | "NOT_FOUND" | "TOO_LARGE" | "EMPTY_VALUE";

export class VaultError extends Error {
  constructor(public readonly code: VaultErrorCode) {
    super(code);
    this.name = "VaultError";
  }
}

// Lowercase, no whitespace: a reference `{{vault:NAME}}` never needs quoting.
export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const VAULT_MAX_VALUE_BYTES = 8192;

export interface VaultEntry {
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

export function isValidVaultName(name: unknown): name is string {
  return typeof name === "string" && VAULT_NAME_RE.test(name);
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export async function putSecret(
  userId: string,
  name: string,
  value: string,
  description?: string | null
): Promise<{ created: boolean }> {
  if (!isValidVaultName(name)) throw new VaultError("INVALID_NAME");
  if (value === "") throw new VaultError("EMPTY_VALUE");
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) throw new VaultError("TOO_LARGE");
  const enc = encrypt(value);

  // `description` is a tri-state: undefined = leave whatever is there alone,
  // null = clear it, string = set it. Only branch the UPDATE — an omitted
  // description on a brand-new row simply has nothing to preserve, so the
  // INSERT below always writes an explicit value (null when unset).
  const runUpdate = async (): Promise<boolean> => {
    const { changes } =
      description === undefined
        ? await db.run(
            "UPDATE user_vaults SET value_enc = ?, updated_at = ? WHERE user_id = ? AND name = ?",
            [enc, nowSec(), userId, name]
          )
        : await db.run(
            "UPDATE user_vaults SET value_enc = ?, description = ?, updated_at = ? WHERE user_id = ? AND name = ?",
            [enc, description, nowSec(), userId, name]
          );
    return changes === 1;
  };

  if (await runUpdate()) return { created: false };

  // Row didn't exist a moment ago — insert it. A concurrent putSecret for the
  // same (userId, name) could have inserted it in the meantime, in which case
  // this INSERT hits the UNIQUE(user_id, name) constraint and throws a raw
  // driver error. Treat that as "someone else just created it": retry the
  // UPDATE once, and only surface the original error if that still misses.
  try {
    await db.run(
      "INSERT INTO user_vaults (id, user_id, name, value_enc, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), userId, name, enc, description ?? null, nowSec(), nowSec()]
    );
    return { created: true };
  } catch (err) {
    if (await runUpdate()) return { created: false };
    throw err;
  }
}

export async function deleteSecret(userId: string, name: string): Promise<boolean> {
  if (!isValidVaultName(name)) return false;
  const { changes } = await db.run("DELETE FROM user_vaults WHERE user_id = ? AND name = ?", [
    userId,
    name,
  ]);
  return changes === 1;
}

export async function listSecrets(userId: string): Promise<VaultEntry[]> {
  return db.all<VaultEntry>(
    "SELECT name, description, created_at, updated_at, last_used_at FROM user_vaults WHERE user_id = ? ORDER BY name",
    [userId]
  );
}

/** The one decrypt path. Returns null for a bad name or a missing row. */
export async function readSecretValue(userId: string, name: string): Promise<string | null> {
  if (!isValidVaultName(name)) return null;
  const row = await db.get<{ value_enc: Buffer | Uint8Array }>(
    "SELECT value_enc FROM user_vaults WHERE user_id = ? AND name = ?",
    [userId, name]
  );
  if (!row) return null;
  return decrypt(Buffer.from(row.value_enc));
}

/** Stamp last_used_at. Unknown names are ignored. */
export async function touchUsed(userId: string, names: string[]): Promise<void> {
  const ts = nowSec();
  for (const name of new Set(names)) {
    if (!isValidVaultName(name)) continue;
    await db.run("UPDATE user_vaults SET last_used_at = ? WHERE user_id = ? AND name = ?", [
      ts,
      userId,
      name,
    ]);
  }
}
