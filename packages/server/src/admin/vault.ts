import { db } from "../db";
import { OTL_SENTINEL } from "../vault/otl";

const DAY = 86_400;
export const STALE_DAYS = 90;

export interface VaultStats {
  secrets: number;
  users_with_secrets: number;
  /** Not used for STALE_DAYS (or never used and older than that). */
  stale: number;
  stale_days: number;
  pending_links: number;
  /** Counts per user only — never a secret's name or value. */
  top_holders: { email: string | null; secrets: number }[];
}

/**
 * Vault aggregates for the admin page. Counts and ages only: not a name, not a
 * description, and never a value — the existence of a secret called
 * `prod-db-password` is itself information this page has no need to show.
 */
export async function getVaultStats(nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<VaultStats> {
  const totals = await db.get<{ n: number | string; users: number | string; stale: number | string | null }>(
    `SELECT COUNT(*) AS n,
            COUNT(DISTINCT user_id) AS users,
            SUM(CASE WHEN COALESCE(last_used_at, created_at) < ? THEN 1 ELSE 0 END) AS stale
       FROM user_vaults`,
    [nowSeconds - STALE_DAYS * DAY]
  );
  const links = await db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM pending_auth WHERE integration = ? AND expires_at > ?",
    [OTL_SENTINEL, nowSeconds]
  );
  const holders = await db.all<{ email: string | null; n: number | string }>(
    `SELECT u.email AS email, COUNT(*) AS n
       FROM user_vaults v
       LEFT JOIN users u ON u.id = v.user_id
      GROUP BY v.user_id, u.email
      ORDER BY n DESC, u.email ASC
      LIMIT 5`
  );
  return {
    secrets: Number(totals?.n ?? 0),
    users_with_secrets: Number(totals?.users ?? 0),
    stale: Number(totals?.stale ?? 0),
    stale_days: STALE_DAYS,
    pending_links: Number(links?.n ?? 0),
    top_holders: holders.map((h) => ({ email: h.email ?? null, secrets: Number(h.n) })),
  };
}
