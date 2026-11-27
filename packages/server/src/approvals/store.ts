import crypto from "node:crypto";
import { db } from "../db";
import type { DbExecutor } from "../db-adapter";

// Persistence for approval_requests. Plain statements, no rules: who may ask,
// who may decide and what an approval does live in kinds.ts and engine.ts.
// Times are epoch seconds. PostgreSQL stores them as BIGINT, which node-pg
// hands back as a string, so every read goes through Number().

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface ApprovalRequest {
  id: string;
  kind: string;
  subject: string;
  requesterId: string;
  message: string;
  /** Kind-specific data fixed at creation (e.g. the Space's created_at). */
  payload: Record<string, unknown> | null;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: number | null;
  decisionNote: string | null;
  createdAt: number;
}

interface Row {
  id: string;
  kind: string;
  subject: string;
  requester_id: string;
  message: string | null;
  payload: string | null;
  status: string;
  decided_by: string | null;
  decided_at: number | string | null;
  decision_note: string | null;
  created_at: number | string;
}

export const COLUMNS =
  "id, kind, subject, requester_id, message, payload, status, decided_by, decided_at, decision_note, created_at";
// The same list with a table alias, for joins.
export const COLUMNS_R = COLUMNS.split(", ")
  .map((c) => `r.${c}`)
  .join(", ");

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function fromRow(r: Row): ApprovalRequest {
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    try {
      const parsed = JSON.parse(r.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      /* malformed: no payload */
    }
  }
  const status = (["pending", "approved", "rejected", "cancelled"] as const).find((s) => s === r.status) ?? "cancelled";
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    requesterId: r.requester_id,
    message: r.message ?? "",
    payload,
    status,
    decidedBy: r.decided_by ?? null,
    decidedAt: r.decided_at === null || r.decided_at === undefined ? null : Number(r.decided_at),
    decisionNote: r.decision_note ?? null,
    createdAt: Number(r.created_at),
  };
}

export async function getRequest(id: string, executor: DbExecutor = db): Promise<ApprovalRequest | null> {
  const row = await executor.get<Row>(`SELECT ${COLUMNS} FROM approval_requests WHERE id = ?`, [id]);
  return row ? fromRow(row) : null;
}

/**
 * Insert a pending request. Returns the new id, or null when this requester
 * already has one open for the subject (the partial unique index decides, in
 * the same statement: no read-then-write window).
 */
export async function insertRequest(
  executor: DbExecutor,
  input: {
    kind: string;
    subject: string;
    requesterId: string;
    message?: string;
    payload?: Record<string, unknown> | null;
  }
): Promise<string | null> {
  const id = crypto.randomUUID();
  const { changes } = await executor.run(
    `INSERT INTO approval_requests (id, kind, subject, requester_id, message, payload, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT (kind, subject, requester_id) WHERE status = 'pending' DO NOTHING`,
    [
      id,
      input.kind,
      input.subject,
      input.requesterId,
      input.message ?? "",
      input.payload ? JSON.stringify(input.payload) : null,
      nowSeconds(),
    ]
  );
  return changes > 0 ? id : null;
}

/**
 * The one statement that decides a request. `WHERE status = 'pending'` is the
 * arbiter: of two concurrent decisions exactly one reports a change, and the
 * loser must not run the kind's effect. Returns whether this call won.
 */
export async function decideRequest(
  executor: DbExecutor,
  id: string,
  status: Exclude<ApprovalStatus, "pending">,
  decidedBy: string | null,
  note: string | null
): Promise<boolean> {
  const { changes } = await executor.run(
    `UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
      WHERE id = ? AND status = 'pending'`,
    [status, decidedBy, nowSeconds(), note, id]
  );
  return changes > 0;
}

/** Turn an approval this transaction just recorded into a rejection (the effect could not apply). */
export async function demoteToRejected(executor: DbExecutor, id: string, note: string): Promise<void> {
  await executor.run(
    "UPDATE approval_requests SET status = 'rejected', decision_note = ? WHERE id = ? AND status = 'approved'",
    [note, id]
  );
}

/** The requester withdraws an open request. True only when it was theirs and still pending. */
export async function cancelRequest(id: string, requesterId: string): Promise<boolean> {
  const { changes } = await db.run(
    `UPDATE approval_requests SET status = 'cancelled', decided_by = ?, decided_at = ?
      WHERE id = ? AND requester_id = ? AND status = 'pending'`,
    [requesterId, nowSeconds(), id, requesterId]
  );
  return changes > 0;
}

/**
 * Close every open request of a kind for a subject (a deleted Space, a user an
 * admin disabled or approved directly). Takes an executor so the caller can do
 * it inside its own transaction.
 */
export async function closeOpenForSubject(
  executor: DbExecutor,
  kind: string,
  subject: string,
  status: Exclude<ApprovalStatus, "pending">,
  decidedBy: string | null,
  note: string | null
): Promise<number> {
  const { changes } = await executor.run(
    `UPDATE approval_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
      WHERE kind = ? AND subject = ? AND status = 'pending'`,
    [status, decidedBy, nowSeconds(), note, kind, subject]
  );
  return changes;
}

export async function pendingRequestFor(
  kind: string,
  subject: string,
  requesterId: string,
  executor: DbExecutor = db
): Promise<ApprovalRequest | null> {
  const row = await executor.get<Row>(
    `SELECT ${COLUMNS} FROM approval_requests WHERE kind = ? AND subject = ? AND requester_id = ? AND status = 'pending'`,
    [kind, subject, requesterId]
  );
  return row ? fromRow(row) : null;
}

/** The newest request (any status) a requester made for a subject. */
export async function latestRequestFor(
  kind: string,
  subject: string,
  requesterId: string,
  executor: DbExecutor = db
): Promise<ApprovalRequest | null> {
  const row = await executor.get<Row>(
    `SELECT ${COLUMNS} FROM approval_requests WHERE kind = ? AND subject = ? AND requester_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [kind, subject, requesterId]
  );
  return row ? fromRow(row) : null;
}

export async function countPending(kind: string, executor: DbExecutor = db): Promise<number> {
  const row = await executor.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM approval_requests WHERE kind = ? AND status = 'pending'",
    [kind]
  );
  return Number(row?.n ?? 0);
}

/** Requests of `kind` the requester made since `sinceSeconds`, whatever became of them. */
export async function countRecentByRequester(
  kind: string,
  requesterId: string,
  sinceSeconds: number,
  subject?: string
): Promise<number> {
  const row = await db.get<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM approval_requests
      WHERE kind = ? AND requester_id = ? AND created_at >= ?${subject === undefined ? "" : " AND subject = ?"}`,
    subject === undefined ? [kind, requesterId, sinceSeconds] : [kind, requesterId, sinceSeconds, subject]
  );
  return Number(row?.n ?? 0);
}

export async function listPendingByRequester(kind: string, requesterId: string): Promise<ApprovalRequest[]> {
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM approval_requests WHERE kind = ? AND requester_id = ? AND status = 'pending'`,
    [kind, requesterId]
  );
  return rows.map(fromRow);
}

/** A requester's own requests of the given kinds, newest first. */
export async function listByRequester(
  requesterId: string,
  kinds: readonly string[],
  limit: number
): Promise<ApprovalRequest[]> {
  if (kinds.length === 0) return [];
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM approval_requests
      WHERE requester_id = ? AND kind IN (${kinds.map(() => "?").join(", ")})
      ORDER BY created_at DESC, id DESC LIMIT ?`,
    [requesterId, ...kinds, limit]
  );
  return rows.map(fromRow);
}

export interface PendingPage {
  rows: Array<ApprovalRequest & { requesterEmail: string | null }>;
  next: string | null;
}

/** Opaque cursor: the last row's (created_at, id). */
function encodeCursor(r: { createdAt: number; id: string }): string {
  return Buffer.from(`${r.createdAt}:${r.id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: number; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const i = raw.indexOf(":");
    const createdAt = Number(raw.slice(0, i));
    const id = raw.slice(i + 1);
    return i > 0 && Number.isFinite(createdAt) && id ? { createdAt, id } : null;
  } catch {
    return null;
  }
}

/** One page of a kind's open requests, newest first, with the requester's email. */
export async function pagePending(kind: string, limit: number, cursor?: string): Promise<PendingPage> {
  const c = decodeCursor(cursor);
  const rows = await db.all<Row & { requester_email: string | null }>(
    `SELECT ${COLUMNS_R}, u.email AS requester_email
       FROM approval_requests r LEFT JOIN users u ON u.id = r.requester_id
      WHERE r.kind = ? AND r.status = 'pending'
        ${c ? "AND (r.created_at < ? OR (r.created_at = ? AND r.id < ?))" : ""}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?`,
    c ? [kind, c.createdAt, c.createdAt, c.id, limit + 1] : [kind, limit + 1]
  );
  const page = rows.slice(0, limit).map((r) => ({ ...fromRow(r), requesterEmail: r.requester_email ?? null }));
  return { rows: page, next: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
}
