import { config } from "../config";
import { db } from "../db";
import type { SqlParam } from "../db-adapter";

export interface AuditEventRow {
  id: number;
  integration: string | null;
  tool: string | null;
  action: string;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  created_at: number;
}

export interface AuditSummary {
  toolCalls: number;
  successRate: number | null;
  mostUsedIntegration: string | null;
}

export interface ListAuditOptions {
  userId: string;
  limit: number;
  cursor?: { createdAt: number; id: number };
  integration?: string;
  status?: "success" | "error";
}

/**
 * Whether audit events land in the database at all. `stdout` and `kafka`
 * destinations write nothing here, so an empty table means "configured
 * elsewhere", not "nothing has happened yet" — and the two must not look
 * the same to a reader.
 */
export function auditStored(): boolean {
  return config.AUDIT_LOG_DEST === "sqlite";
}

export function encodeCursor(createdAt: number, id: number): string {
  return Buffer.from(`${createdAt}:${id}`).toString("base64url");
}

/**
 * Decode a paging cursor, or null if it is not one we minted. Base64 decoding
 * never throws on junk — it just yields junk — so the shape check below is
 * what actually rejects a hand-edited cursor.
 */
export function decodeCursor(cursor: string): { createdAt: number; id: number } | null {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const m = raw.match(/^(\d{1,15}):(\d{1,15})$/);
  if (!m) return null;
  return { createdAt: Number(m[1]), id: Number(m[2]) };
}

function normalize(r: Record<string, unknown>): AuditEventRow {
  return {
    id: Number(r.id),
    integration: (r.integration as string | null) ?? null,
    tool: (r.tool as string | null) ?? null,
    action: String(r.action),
    // SQLite hands back 1/0, PostgreSQL a real boolean.
    success: !!r.success,
    error: (r.error as string | null) ?? null,
    duration_ms: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    created_at: Number(r.created_at),
  };
}

export async function listAuditEvents(o: ListAuditOptions): Promise<AuditEventRow[]> {
  const where: string[] = ["user_id = ?"];
  const params: SqlParam[] = [o.userId];

  if (o.integration) {
    where.push("integration = ?");
    params.push(o.integration);
  }
  if (o.status) {
    where.push("success = ?");
    params.push(o.status === "success");
  }
  if (o.cursor) {
    // Longhand rather than a row-value comparison: the two backends do not
    // agree on `(created_at, id) < (?, ?)`.
    where.push("(created_at < ? OR (created_at = ? AND id < ?))");
    params.push(o.cursor.createdAt, o.cursor.createdAt, o.cursor.id);
  }
  params.push(o.limit);

  const rows = await db.all<Record<string, unknown>>(
    `SELECT id, integration, tool, action, success, error, duration_ms, created_at
       FROM audit_log
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params
  );
  return rows.map(normalize);
}

export async function summarizeAudit(userId: string, windowDays: number): Promise<AuditSummary> {
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;

  const totals = await db.get<{ n: number | string; ok: number | string | null }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN success THEN 1 ELSE 0 END) AS ok
       FROM audit_log
      WHERE user_id = ? AND action = 'EXECUTE' AND created_at >= ?`,
    [userId, since]
  );
  const toolCalls = Number(totals?.n ?? 0);
  const ok = Number(totals?.ok ?? 0);

  const top = await db.get<{ integration: string }>(
    `SELECT integration
       FROM audit_log
      WHERE user_id = ? AND action = 'EXECUTE' AND created_at >= ? AND integration IS NOT NULL
      GROUP BY integration
      ORDER BY COUNT(*) DESC, integration ASC
      LIMIT 1`,
    [userId, since]
  );

  return {
    toolCalls,
    // Three decimals is enough for a percentage rendered to the nearest point.
    successRate: toolCalls === 0 ? null : Math.round((ok / toolCalls) * 1000) / 1000,
    mostUsedIntegration: top?.integration ?? null,
  };
}

export interface AdminAuditEventRow extends AuditEventRow {
  user_id: string;
  user_email: string | null;
}

export interface ListAllAuditOptions {
  limit: number;
  cursor?: { createdAt: number; id: number };
  integration?: string;
  status?: "success" | "error";
  /** Exact match on the user's email, case-insensitive. */
  email?: string;
}

/**
 * Every user's events, newest first, each with its owner's email. LEFT JOIN so
 * an event whose user row is gone still appears, with a null email. Keyset
 * paging uses the same longhand predicate as listAuditEvents: the two backends
 * do not agree on a row-value comparison.
 */
export async function listAllAuditEvents(o: ListAllAuditOptions): Promise<AdminAuditEventRow[]> {
  const where: string[] = [];
  const params: SqlParam[] = [];

  if (o.integration) {
    where.push("a.integration = ?");
    params.push(o.integration);
  }
  if (o.status) {
    where.push("a.success = ?");
    params.push(o.status === "success");
  }
  if (o.email) {
    where.push("LOWER(u.email) = ?");
    params.push(o.email.trim().toLowerCase());
  }
  if (o.cursor) {
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    params.push(o.cursor.createdAt, o.cursor.createdAt, o.cursor.id);
  }
  params.push(o.limit);

  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.user_id, u.email AS user_email, a.integration, a.tool, a.action,
            a.success, a.error, a.duration_ms, a.created_at
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    ...normalize(r),
    user_id: String(r.user_id),
    user_email: (r.user_email as string | null) ?? null,
  }));
}
