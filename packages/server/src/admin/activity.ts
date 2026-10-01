import {
  auditStored,
  decodeCursor,
  encodeCursor,
  listAllAuditEvents,
  type AdminAuditEventRow,
} from "../audit/query";

type Raw = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export type AdminActivityResult =
  | { ok: true; page: { stored: boolean; events: AdminAuditEventRow[]; next_cursor: string | null } }
  | { ok: false; error: "invalid_cursor" };

export async function adminActivity(raw: Raw): Promise<AdminActivityResult> {
  // stdout and kafka write nothing to the table, so an empty list would read as
  // "nothing happened". Say so instead.
  if (!auditStored()) return { ok: true, page: { stored: false, events: [], next_cursor: null } };

  const rawLimit = first(raw.limit);
  const requested = Number(rawLimit);
  const limit =
    rawLimit === undefined || !Number.isFinite(requested)
      ? 50
      : Math.min(100, Math.max(1, Math.floor(requested)));

  let cursor: { createdAt: number; id: number } | undefined;
  const rawCursor = first(raw.cursor);
  if (rawCursor) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) return { ok: false, error: "invalid_cursor" };
    cursor = decoded;
  }

  const rawStatus = first(raw.status);
  const status = rawStatus === "success" || rawStatus === "error" ? rawStatus : undefined;

  // One extra row: its presence says another page exists, without a COUNT.
  const rows = await listAllAuditEvents({
    limit: limit + 1,
    cursor,
    integration: first(raw.integration),
    status,
    email: first(raw.email),
  });
  const events = rows.slice(0, limit);
  const last = events[events.length - 1];
  const next_cursor = rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null;
  return { ok: true, page: { stored: true, events, next_cursor } };
}
