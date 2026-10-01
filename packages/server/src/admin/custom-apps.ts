import { db } from "../db";

export interface CustomAppRow {
  id: string;
  name: string;
  base_url: string;
  owner_email: string | null;
  created_at: number;
}

// Explicit column list, never SELECT *: client_id and client_secret_enc live on
// this table and must not reach a response.
export async function listAllCustomApps(limit = 200): Promise<{ apps: CustomAppRow[]; total: number }> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.name, a.base_url, a.created_at, u.email AS owner_email
       FROM custom_apps a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [limit]
  );
  const count = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM custom_apps");
  return {
    apps: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      base_url: String(r.base_url),
      owner_email: (r.owner_email as string | null) ?? null,
      created_at: Number(r.created_at),
    })),
    total: Number(count?.n ?? 0),
  };
}
