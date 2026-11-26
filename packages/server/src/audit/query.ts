import { config } from "../config";
import { parseAuditDest } from "./destinations";
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

/**
 * How a delegated Space call relates to the reader. `for_me`: someone else
 * used my access. `by_me`: I used someone else's. The other person is named
 * by email only, never by user id.
 */
export interface AuditDelegation {
  direction: "by_me" | "for_me";
  other_email: string | null;
  space: string | null;
}

export interface UserAuditEventRow extends AuditEventRow {
  /** Null for an ordinary call on the reader's own access. */
  delegation: AuditDelegation | null;
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
 * Whether audit events land in the database at all. With `stdout` alone
 * nothing is written here, so an empty table means "configured elsewhere",
 * not "nothing has happened yet" — and the two must not look the same to a
 * reader. `kafka` is always a copy alongside the database.
 */
export function auditStored(): boolean {
  return parseAuditDest(config.AUDIT_LOG_DEST).includes("db");
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

const SPACE_CLIENT_PREFIX = "space:";

function spaceFromClient(clientName: unknown): string | null {
  if (typeof clientName !== "string" || !clientName.startsWith(SPACE_CLIENT_PREFIX)) return null;
  return clientName.slice(SPACE_CLIENT_PREFIX.length) || null;
}

function delegationFor(me: string, r: Record<string, unknown>): AuditDelegation | null {
  const owner = String(r.user_id);
  const actor = (r.actor_user_id as string | null) ?? null;
  // No actor, or the owner triggering their own access: an ordinary call.
  if (actor === null || actor === owner) return null;
  const space = spaceFromClient(r.client_name);
  if (actor === me) return { direction: "by_me", other_email: (r.owner_email as string | null) ?? null, space };
  if (owner === me) return { direction: "for_me", other_email: (r.actor_email as string | null) ?? null, space };
  return null;
}

export async function listAuditEvents(o: ListAuditOptions): Promise<UserAuditEventRow[]> {
  // Calls on my access, and delegated calls I made on someone else's. The OR
  // cannot use one index for the ORDER BY, so each page sorts its matches;
  // fine at Activity volumes. If it shows up in profiles, switch to a UNION
  // ALL of two keyset queries (idx on user_id, idx_audit_actor_nn) merged
  // and limited in the outer query.
  const where: string[] = ["(a.user_id = ? OR a.actor_user_id = ?)"];
  const params: SqlParam[] = [o.userId, o.userId];

  if (o.integration) {
    where.push("a.integration = ?");
    params.push(o.integration);
  }
  if (o.status) {
    where.push("a.success = ?");
    params.push(o.status === "success");
  }
  if (o.cursor) {
    // Longhand rather than a row-value comparison: the two backends do not
    // agree on `(created_at, id) < (?, ?)`.
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    params.push(o.cursor.createdAt, o.cursor.createdAt, o.cursor.id);
  }
  params.push(o.limit);

  // Both people by their current email, falling back to the one recorded
  // with the event when the user row is gone.
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.integration, a.tool, a.action, a.success, a.error, a.duration_ms, a.created_at,
            a.user_id, a.actor_user_id, a.client_name,
            COALESCE(ou.email, a.user_email) AS owner_email,
            COALESCE(au.email, a.actor_email) AS actor_email
       FROM audit_log a
       LEFT JOIN users ou ON ou.id = a.user_id
       LEFT JOIN users au ON au.id = a.actor_user_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    params
  );
  return rows.map((r) => ({ ...normalize(r), delegation: delegationFor(o.userId, r) }));
}

/**
 * Counts calls on the user's own access (`user_id`), so a delegated call is
 * the owner's: it spent their access. A viewer's calls through someone else's
 * Space show in their Activity list but not in this summary.
 */
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
  /** The current email, or the one recorded with the event if the user is gone. */
  user_email: string | null;
  /** Arguments / result were captured for this event (AUDIT_PAYLOAD). */
  has_payload: boolean;
  /** Request origin and credential, when the event came from a request. */
  source_ip: string | null;
  user_agent: string | null;
  auth_method: string | null;
  client_id: string | null;
  client_name: string | null;
  /** Who triggered a delegated call; null for ordinary calls. */
  actor_user_id: string | null;
  /** The actor's current email, or the one recorded with the event. */
  actor_email: string | null;
}

export interface AuditPayload {
  audit_id: number;
  args: string | null;
  args_truncated: boolean;
  args_bytes: number | null;
  result: string | null;
  result_truncated: boolean;
  result_bytes: number | null;
}

export async function getAuditPayload(auditId: number): Promise<AuditPayload | null> {
  const r = await db.get<Record<string, unknown>>(
    "SELECT audit_id, args, args_truncated, args_bytes, result, result_truncated, result_bytes FROM audit_payload WHERE audit_id = ?",
    [auditId]
  );
  if (!r) return null;
  return {
    audit_id: Number(r.audit_id),
    args: (r.args as string | null) ?? null,
    args_truncated: !!r.args_truncated,
    args_bytes: r.args_bytes === null || r.args_bytes === undefined ? null : Number(r.args_bytes),
    result: (r.result as string | null) ?? null,
    result_truncated: !!r.result_truncated,
    result_bytes: r.result_bytes === null || r.result_bytes === undefined ? null : Number(r.result_bytes),
  };
}

export interface ListAllAuditOptions {
  limit: number;
  cursor?: { createdAt: number; id: number };
  integration?: string;
  status?: "success" | "error";
  /** Exact match on either person's email (owner or actor), case-insensitive. */
  email?: string;
}

/**
 * Every user's events, newest first, each with its owner's email (and the
 * actor's, for a delegated call). LEFT JOIN so an event whose user row is gone
 * still appears, with the email recorded on the event. Keyset
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
    const email = o.email.trim().toLowerCase();
    where.push("(LOWER(COALESCE(u.email, a.user_email)) = ? OR LOWER(COALESCE(au.email, a.actor_email)) = ?)");
    params.push(email, email);
  }
  if (o.cursor) {
    where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
    params.push(o.cursor.createdAt, o.cursor.createdAt, o.cursor.id);
  }
  params.push(o.limit);

  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.id, a.user_id, COALESCE(u.email, a.user_email) AS user_email, a.integration, a.tool, a.action,
            a.success, a.error, a.duration_ms, a.created_at,
            a.source_ip, a.user_agent, a.auth_method, a.client_id, a.client_name,
            a.actor_user_id, COALESCE(au.email, a.actor_email) AS actor_email,
            CASE WHEN p.audit_id IS NULL THEN 0 ELSE 1 END AS has_payload
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users au ON au.id = a.actor_user_id
       LEFT JOIN audit_payload p ON p.audit_id = a.id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    ...normalize(r),
    user_id: String(r.user_id),
    user_email: (r.user_email as string | null) ?? null,
    has_payload: Number(r.has_payload) === 1,
    source_ip: (r.source_ip as string | null) ?? null,
    user_agent: (r.user_agent as string | null) ?? null,
    auth_method: (r.auth_method as string | null) ?? null,
    client_id: (r.client_id as string | null) ?? null,
    client_name: (r.client_name as string | null) ?? null,
    actor_user_id: (r.actor_user_id as string | null) ?? null,
    actor_email: (r.actor_email as string | null) ?? null,
  }));
}
