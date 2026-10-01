import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "../db";
import { encrypt, decrypt } from "./encryption";
import { isUserDisabled } from "./user-status";

// Indexed lookup handle for an api key. Keys are 32 random bytes minted here —
// never user-chosen — so a plain SHA-256 is not brute-forceable and needs no
// per-candidate work factor. bcrypt's cost only ever protected low-entropy
// secrets; here it just made every /mcp request scan the whole users table.
function apiKeySha(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export async function createUser(id: string): Promise<{ apiKey: string }> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  const hash = bcrypt.hashSync(apiKey, 10);
  await db.run(
    "INSERT INTO users (id, api_key_hash, api_key_sha, api_key_enc) VALUES (?, ?, ?, ?)",
    [id, hash, apiKeySha(apiKey), encrypt(apiKey)]
  );
  return { apiKey };
}

export async function setApiKey(userId: string): Promise<{ apiKey: string }> {
  const apiKey = crypto.randomBytes(32).toString("hex");
  const hash = bcrypt.hashSync(apiKey, 10);
  await db.run(
    "UPDATE users SET api_key_hash = ?, api_key_sha = ?, api_key_enc = ? WHERE id = ?",
    [hash, apiKeySha(apiKey), encrypt(apiKey), userId]
  );
  return { apiKey };
}

export async function getApiKey(userId: string): Promise<string | null> {
  const row = await db.get<{ api_key_enc: Buffer | null }>(
    "SELECT api_key_enc FROM users WHERE id = ?",
    [userId]
  );
  if (!row?.api_key_enc) return null;
  return decrypt(row.api_key_enc);
}

export async function clearApiKey(userId: string): Promise<void> {
  await db.run(
    "UPDATE users SET api_key_hash = NULL, api_key_sha = NULL, api_key_enc = NULL WHERE id = ?",
    [userId]
  );
}

export async function hasApiKey(userId: string): Promise<boolean> {
  const row = await db.get<{ api_key_hash: string | null }>(
    "SELECT api_key_hash FROM users WHERE id = ?",
    [userId]
  );
  return !!row?.api_key_hash;
}

// Runs on every /mcp request. Was: SELECT every user, then bcrypt.compareSync
// against each hash — O(users) of event-loop-blocking work (~2.8s at 100 users,
// and the MCP handshake pays it twice). Now one indexed lookup.
async function findApiKeyOwner(apiKey: string): Promise<string | null> {
  const row = await db.get<{ id: string }>("SELECT id FROM users WHERE api_key_sha = ?", [
    apiKeySha(apiKey),
  ]);
  if (row) return row.id;

  // Keys minted before api_key_sha existed have only a bcrypt hash. Verify the
  // slow way once, then backfill so this key takes the fast path from now on.
  const legacy = await db.all<{ id: string; api_key_hash: string }>(
    "SELECT id, api_key_hash FROM users WHERE api_key_sha IS NULL AND api_key_hash IS NOT NULL"
  );
  for (const user of legacy) {
    if (await bcrypt.compare(apiKey, user.api_key_hash)) {
      await db.run("UPDATE users SET api_key_sha = ? WHERE id = ?", [apiKeySha(apiKey), user.id]);
      return user.id;
    }
  }
  return null;
}

export async function verifyApiKey(apiKey: string): Promise<string | null> {
  const id = await findApiKeyOwner(apiKey);
  // A disabled account's key stops working at once. The key stays on the row,
  // so enabling the user restores it.
  if (id && (await isUserDisabled(id))) return null;
  return id;
}

export async function getUserById(userId: string): Promise<{ id: string; email: string | null } | null> {
  const row = await db.get<{ id: string; email: string | null }>(
    "SELECT id, email FROM users WHERE id = ?",
    [userId]
  );
  return row ?? null;
}
