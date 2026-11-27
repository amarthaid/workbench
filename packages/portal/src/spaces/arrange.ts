import type { SpaceSummary } from "../spaces-api";

export type SpaceFilter = "all" | "mine" | "shared";

export const RECENT_LIMIT = 4;
/** More favorites than this still show, but as compact tiles: a wall of large ones hides everything else. */
export const LARGE_FAVORITES = 6;
export const NEW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Someone else's Space that changed recently and that I have never opened. */
export function isNewForMe(s: SpaceSummary, now: number): boolean {
  return !s.mine && s.last_opened_at === null && now - s.updatedAt < NEW_WINDOW_MS;
}

export interface Arranged {
  /** My favorites, most recently opened first. */
  favorites: SpaceSummary[];
  /** Not favorites, but opened lately by me. */
  recent: SpaceSummary[];
  /** Everything else, most recently updated first. */
  rest: SpaceSummary[];
}

function matches(s: SpaceSummary, query: string): boolean {
  if (!query) return true;
  const hay = `${s.title} ${s.description ?? ""} ${s.ownerEmail} ${s.name}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

// What goes first is decided by what the person did, not by how popular a
// Space is: favorites, then what they opened lately, then the rest by update
// time. Popularity would put the Spaces open to everyone on top for everybody,
// and it would reward whatever is already on top.
export function arrangeSpaces(spaces: SpaceSummary[], opts: { query?: string; filter?: SpaceFilter } = {}): Arranged {
  const query = (opts.query ?? "").trim();
  const filter = opts.filter ?? "all";
  const visible = spaces.filter(
    (s) => matches(s, query) && (filter === "all" || (filter === "mine" ? s.mine : !s.mine))
  );
  const byOpened = (a: SpaceSummary, b: SpaceSummary) =>
    (b.last_opened_at ?? -1) - (a.last_opened_at ?? -1) || a.title.localeCompare(b.title);
  const favorites = visible.filter((s) => s.favorited).sort(byOpened);
  const others = visible.filter((s) => !s.favorited);
  const opened = others.filter((s) => s.last_opened_at !== null).sort(byOpened);
  const recent = opened.slice(0, RECENT_LIMIT);
  const shown = new Set(recent.map((s) => s.name));
  const rest = others
    .filter((s) => !shown.has(s.name))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  return { favorites, recent, rest };
}
