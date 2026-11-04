import {
  auditStored,
  decodeCursor,
  encodeCursor,
  getAuditPayload,
  listAllAuditEvents,
  type AdminAuditEventRow,
  type AuditPayload,
} from "../audit/query";
import { auditLogger } from "../audit/logger";
import type { AdminActor } from "../api/admin-scope";

type Raw = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export type AdminActivityResult =
  | { ok: true; page: { stored: boolean; events: AdminAuditEventRow[]; next_cursor: string | null } }
  | { ok: false; error: "invalid_cursor" | "invalid_status" };

export async function adminActivity(raw: Raw): Promise<AdminActivityResult> {
  // stdout and kafka write nothing to the table, so an empty list would read as
  // "nothing happened". Say so instead.
  if (!auditStored()) return { ok: true, page: { stored: false, events: [], next_cursor: null } };

  // An empty `?limit=` means "not given", not zero.
  const rawLimit = first(raw.limit) || undefined;
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

  // A filter that is not understood is refused, not ignored: ignoring it would
  // return every event while the caller believes it filtered.
  const rawStatus = first(raw.status) || undefined;
  if (rawStatus !== undefined && rawStatus !== "success" && rawStatus !== "error") {
    return { ok: false, error: "invalid_status" };
  }
  const status = rawStatus;

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

/**
 * One event's captured arguments / result. Reading them is itself audited
 * (ADMIN_AUDIT_PAYLOAD_VIEW), because they can hold another user's data.
 */
export async function adminActivityPayload(
  actor: AdminActor,
  rawId: string
): Promise<{ ok: true; payload: AuditPayload } | { ok: false; status: 400 | 404; error: "invalid_id" | "not_found" }> {
  if (!/^\d{1,15}$/.test(rawId)) return { ok: false, status: 400, error: "invalid_id" };
  const payload = await getAuditPayload(Number(rawId));
  if (!payload) return { ok: false, status: 404, error: "not_found" };
  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_AUDIT_PAYLOAD_VIEW",
    tool: `admin.activity.payload id=${payload.audit_id}`,
    success: true,
  });
  return { ok: true, payload };
}
