import { db } from "../db";
import { favoriteCounts, openersOf } from "../spaces/store";

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
 * Names are lowercase slugs, so q is lowercased once. Prefix is LIKE, not a
 * `name >= q AND name < q + high` range: that comparison follows the column
 * collation, and PostgreSQL's locale collations ignore punctuation (a name
 * like `rep_live` was not found by `rep_`). The spaces table is small and the
 * query is limited, so a scan is fine.
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
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const like = `%${escaped}%`;
  const prefix = `${escaped}%`;
  const rows = await db.all<{ name: string; title: string; owner_email: string | null }>(
    `SELECT s.name, s.title, u.email AS owner_email,
            CASE WHEN s.name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END AS match_rank
       FROM spaces s
       LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.name LIKE ? ESCAPE '\\' OR LOWER(s.title) LIKE ? ESCAPE '\\'
      ORDER BY match_rank, s.name
      LIMIT ?`,
    [prefix, prefix, like, limit + 1]
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

// ---- the admin Spaces list ---------------------------------------------------

export const SPACE_LIST_DEFAULT = 24;
export const SPACE_LIST_MAX = 100;
const OPENERS_WINDOW_MS = 30 * 86_400_000;
export const OPENERS_LIST_MAX = 50;

export interface AdminSpaceItem {
  name: string;
  title: string;
  description: string | null;
  owner_email: string | null;
  visibility: string;
  updated_at: number;
  share_count: number;
  favorite_count: number;
  openers_30d: number;
  openers: { email: string; last_opened_at: number }[];
}

export type SpaceListResult =
  | { ok: true; spaces: AdminSpaceItem[]; has_more: boolean; next_cursor: string | null }
  | { ok: false; status: 400; error: "invalid_q" | "invalid_limit" | "invalid_cursor" };

function encodeCursor(updatedAt: number, name: string): string {
  return Buffer.from(JSON.stringify([updatedAt, name]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): [number, string] | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && Number.isFinite(v[0]) && typeof v[1] === "string") {
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Every Space, newest updated first, for the admin Spaces tab. Keyset paged on
 * (updated_at DESC, name ASC) with the longhand predicate
 * `updated_at < ? OR (updated_at = ? AND name > ?)`: rows share a timestamp, and
 * a row-value comparison is not portable across SQLite and PostgreSQL.
 * Shares, likes and openers are read in one query each for the visible page
 * only, so the cost does not grow with the number of Spaces.
 */
export async function listAdminSpaces(
  query: Record<string, string | string[] | undefined>,
  nowMs: number = Date.now()
): Promise<SpaceListResult> {
  let limit = SPACE_LIST_DEFAULT;
  const rawLimit = first(query.limit);
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) return { ok: false, status: 400, error: "invalid_limit" };
    limit = Math.min(Number(rawLimit), SPACE_LIST_MAX);
  }
  const q = (first(query.q) ?? "").trim().toLowerCase();
  if (q.length > SPACE_SEARCH_Q_MAX) return { ok: false, status: 400, error: "invalid_q" };
  const rawCursor = first(query.cursor);
  let cursor: [number, string] | null = null;
  if (rawCursor !== undefined && rawCursor !== "") {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return { ok: false, status: 400, error: "invalid_cursor" };
  }

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q !== "") {
    const escaped = q.replace(/[\\%_]/g, "\\$&");
    where.push("(s.name LIKE ? ESCAPE '\\' OR LOWER(s.title) LIKE ? ESCAPE '\\')");
    params.push(`${escaped}%`, `%${escaped}%`);
  }
  if (cursor) {
    where.push("(s.updated_at < ? OR (s.updated_at = ? AND s.name > ?))");
    params.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = await db.all<{
    name: string;
    title: string;
    description: string | null;
    owner_email: string | null;
    visibility: string;
    updated_at: number | string;
  }>(
    `SELECT s.name, s.title, s.description, u.email AS owner_email, s.visibility, s.updated_at
       FROM spaces s LEFT JOIN users u ON u.id = s.owner_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.updated_at DESC, s.name ASC
      LIMIT ?`,
    [...params, limit + 1]
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const names = page.map((r) => String(r.name));

  const [shareRows, likes, openers] = await Promise.all([
    names.length === 0
      ? Promise.resolve([] as { space_name: string; n: number | string }[])
      : db.all<{ space_name: string; n: number | string }>(
          `SELECT space_name, COUNT(*) AS n FROM space_shares WHERE space_name IN (${names.map(() => "?").join(",")}) GROUP BY space_name`,
          names
        ),
    favoriteCounts(names),
    openersOf(names, nowMs - OPENERS_WINDOW_MS),
  ]);
  const shares = new Map(shareRows.map((r) => [String(r.space_name), Number(r.n)]));

  const spaces = page.map((r): AdminSpaceItem => {
    const list = openers.get(String(r.name)) ?? [];
    return {
      name: String(r.name),
      title: String(r.title),
      description: r.description ?? null,
      owner_email: r.owner_email ?? null,
      visibility: String(r.visibility),
      updated_at: Number(r.updated_at),
      share_count: shares.get(String(r.name)) ?? 0,
      favorite_count: likes.get(String(r.name)) ?? 0,
      openers_30d: list.length,
      openers: list.slice(0, OPENERS_LIST_MAX).map((o) => ({ email: o.email, last_opened_at: o.lastOpenedAt })),
    };
  });
  const last = spaces[spaces.length - 1];
  return { ok: true, spaces, has_more: hasMore, next_cursor: hasMore && last ? encodeCursor(last.updated_at, last.name) : null };
}
