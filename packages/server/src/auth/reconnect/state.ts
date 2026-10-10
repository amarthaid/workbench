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
  /**
   * epoch ms of the last recipe run (credentials may have been typed),
   * whatever its outcome. Holds the cooldown on its own: a later fast-path
   * success writes `last`, never this, so it cannot shorten the window.
   */
  recipeAt?: number;
  /**
   * epoch ms of the last portal-session clear (a human reconnected by hand or
   * changed the bindings). Recipe runs before it no longer hold a cooldown.
   * Only portal-session paths write it.
   */
  clearedAt?: number;
}

type ConfigRead =
  | { kind: "none" } // no connection row
  | { kind: "unparsable" } // config text that is not a JSON object: never ours to rewrite
  | { kind: "ok"; cfg: Record<string, unknown> };

async function readConfig(userId: string, integration: string): Promise<ConfigRead> {
  const row = await db.get<{ config: string | null }>(
    "SELECT config FROM connections WHERE user_id = ? AND integration = ?",
    [userId, integration]
  );
  if (!row) return { kind: "none" };
  if (!row.config) return { kind: "ok", cfg: {} };
  try {
    const parsed = JSON.parse(row.config) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { kind: "ok", cfg: parsed as Record<string, unknown> }
      : { kind: "unparsable" };
  } catch {
    return { kind: "unparsable" };
  }
}

export async function getReconnectState(userId: string, integration: string): Promise<ReconnectState> {
  const read = await readConfig(userId, integration);
  const r = read.kind === "ok" ? read.cfg.reconnect : undefined;
  return r && typeof r === "object" ? (r as ReconnectState) : {};
}

/**
 * Shallow-merge `patch` into the state. Writes nothing when there is no
 * connection row, when the stored config is not a JSON object (it is left
 * untouched), or when the patch would not change the state.
 */
export async function updateReconnectState(
  userId: string,
  integration: string,
  patch: Partial<ReconnectState>
): Promise<void> {
  const read = await readConfig(userId, integration);
  if (read.kind !== "ok") return;
  const cfg = read.cfg;
  const prev = cfg.reconnect && typeof cfg.reconnect === "object" ? (cfg.reconnect as Record<string, unknown>) : {};
  const next: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  const out = { ...cfg };
  if (Object.keys(next).length) out.reconnect = next;
  else delete out.reconnect;
  await db.run(
    "UPDATE connections SET config = ? WHERE user_id = ? AND integration = ?",
    [Object.keys(out).length ? JSON.stringify(out) : null, userId, integration]
  );
}
