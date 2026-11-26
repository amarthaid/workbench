import { db } from "../db";

export const SPACE_SEARCH_MAX = 20;
export const SPACE_SEARCH_Q_MIN = 2;
export const SPACE_SEARCH_Q_MAX = 64;

export interface AdminSpaceHit {
  name: string;
  title: string;
  owner_email: string | null;
}

export type SpaceSearchResult =
  | { ok: true; spaces: AdminSpaceHit[]; has_more: boolean }
  | { ok: false; status: 400; error: "invalid_q" | "invalid_limit" };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Search Spaces by name prefix or title substring for the admin picker.
 * Never loads the whole table: LIMIT limit+1 gives `has_more` without a count.
 * Names are lowercase slugs, so q is lowercased once and compared on both
 * backends; title goes through LOWER() + LIKE ... ESCAPE, which both support.
 */
export async function searchAdminSpaces(
  query: Record<string, string | string[] | undefined>
): Promise<SpaceSearchResult> {
  const q = (first(query.q) ?? "").trim().toLowerCase();
  if (q.length < SPACE_SEARCH_Q_MIN || q.length > SPACE_SEARCH_Q_MAX) {
    return { ok: false, status: 400, error: "invalid_q" };
  }
  let limit = SPACE_SEARCH_MAX;
  const rawLimit = first(query.limit);
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) return { ok: false, status: 400, error: "invalid_limit" };
    limit = Math.min(Number(rawLimit), SPACE_SEARCH_MAX);
  }
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db.all<{ name: string; title: string; owner_email: string | null }>(
    `SELECT s.name, s.title, u.email AS owner_email,
            CASE WHEN s.name >= ? AND s.name < ? THEN 0 ELSE 1 END AS match_rank
       FROM spaces s
       LEFT JOIN users u ON u.id = s.owner_id
      WHERE (s.name >= ? AND s.name < ?) OR LOWER(s.title) LIKE ? ESCAPE '\\'
      ORDER BY match_rank, s.name
      LIMIT ?`,
    [q, q + "￿", q, q + "￿", like, limit + 1]
  );
  return {
    ok: true,
    has_more: rows.length > limit,
    spaces: rows.slice(0, limit).map((r) => ({
      name: String(r.name),
      title: String(r.title),
      owner_email: r.owner_email ?? null,
    })),
  };
}
