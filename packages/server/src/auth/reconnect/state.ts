import { db } from "../../db";

// Auto-reconnect state rides in connections.config (JSON text) under the
// `reconnect` key, beside whatever per-connection config the plugin already
// keeps there. No DDL: see docs/superpowers/specs/2026-10-10-cookie-auto-reconnect-design.md.

export interface ReconnectState {
  /** credential slot key -> vault entry name (names, never values) */
  bindings?: Record<string, string>;
  /** epoch ms when the session was found dead and not recovered */
  deadAt?: number;
  last?: { at: number; ok: boolean; error?: string };
}

async function readConfig(userId: string, integration: string): Promise<Record<string, unknown> | null> {
  const row = await db.get<{ config: string | null }>(
    "SELECT config FROM connections WHERE user_id = ? AND integration = ?",
    [userId, integration]
  );
  if (!row) return null;
  if (!row.config) return {};
  try {
    const parsed = JSON.parse(row.config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function getReconnectState(userId: string, integration: string): Promise<ReconnectState> {
  const cfg = await readConfig(userId, integration);
  const r = cfg?.reconnect;
  return r && typeof r === "object" ? (r as ReconnectState) : {};
}

/** Shallow-merge `patch` into the state. No-op when there is no connection row. */
export async function updateReconnectState(
  userId: string,
  integration: string,
  patch: Partial<ReconnectState>
): Promise<void> {
  const cfg = await readConfig(userId, integration);
  if (cfg === null) return;
  const next: Record<string, unknown> = { ...((cfg.reconnect as object) ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  const out = { ...cfg };
  if (Object.keys(next).length) out.reconnect = next;
  else delete out.reconnect;
  await db.run(
    "UPDATE connections SET config = ? WHERE user_id = ? AND integration = ?",
    [Object.keys(out).length ? JSON.stringify(out) : null, userId, integration]
  );
}
