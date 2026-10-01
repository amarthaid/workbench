import { db } from "../db";

export interface ConnectionRow {
  integration: string;
  connected: number;
  needs_reconnect: number;
}

/**
 * Connected-user counts per integration. `connections` records no refresh
 * failure, so "needs reconnect" means the access token has expired and there is
 * no refresh token to renew it. A cookie or API-key connection has a null
 * expires_at and never counts. Custom-app connections (`custom:<id>`) are
 * listed on their own card, so they are left out here.
 */
export async function getConnectionStats(
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ integrations: ConnectionRow[] }> {
  const rows = await db.all<{
    integration: string;
    connected: number | string;
    needs_reconnect: number | string | null;
  }>(
    `SELECT integration,
            COUNT(*) AS connected,
            SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < ? AND refresh_token IS NULL
                     THEN 1 ELSE 0 END) AS needs_reconnect
       FROM connections
      WHERE integration NOT LIKE ?
      GROUP BY integration
      ORDER BY integration`,
    [nowSeconds, "custom:%"]
  );
  return {
    integrations: rows.map((r) => ({
      integration: r.integration,
      connected: Number(r.connected),
      needs_reconnect: Number(r.needs_reconnect ?? 0),
    })),
  };
}
