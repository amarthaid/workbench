// The registered name of an OAuth client, for audit events. Cached: clients
// rarely change, and every tool call over an OAuth token asks. A lookup
// failure records no name rather than failing the call.

import { db } from "../db";

const TTL_MS = 10 * 60_000;
const CACHE_MAX = 2_000;
const NAME_MAX = 200;
const cache = new Map<string, { name: string | null; at: number }>();

export async function oauthClientName(clientId: string): Promise<string | null> {
  const hit = cache.get(clientId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let name: string | null = null;
  try {
    const row = await db.get<{ client_name: string | null }>(
      "SELECT client_name FROM oauth_clients WHERE client_id = ?",
      [clientId]
    );
    name = row?.client_name ? row.client_name.slice(0, NAME_MAX) : null;
  } catch {
    return hit?.name ?? null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(clientId, { name, at: Date.now() });
  return name;
}

/** Test seam. */
export function resetClientNameCache(): void {
  cache.clear();
}
