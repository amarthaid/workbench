import { randomUUID } from "node:crypto";
import { db } from "../db";

export type ConnectionType = "oauth2" | "cookie" | "apikey";
export type ConnectionStatus = "PENDING" | "CONNECTED" | "EXPIRED";

export interface PendingConnection {
  connectionId: string;
  userId: string;
  integration: string;
  type: ConnectionType;
  status: ConnectionStatus;
  createdAt: number; // unix seconds
  expiresAt: number; // unix seconds
  /**
   * Set when a human proved ownership of `userId` and redeemed the link. A
   * record carrying this cannot be redeemed again, so a leaked link URL is
   * inert once used. Distinct from `status`, which stays PENDING until the
   * connection actually completes.
   */
  redeemedAt?: number;
}

// Pending connections live in `pending_auth` under a sentinel `integration`,
// like jot upload tokens (jots/pending.ts) and presign grants.
//
// They used to live in a process-local Map. Under CLUSTER_ENABLED every pod
// forks one worker per CPU, and more pods run behind the HPA, so the agent's
// connect() call minted the record in one process while the portal's redeem
// (and the OAuth callback, and wait_for_connection) usually landed in another.
// That process had never heard of the connectionId and answered LINK_CONSUMED:
// every fresh link read as "already used". A restart lost them all too.
//
// Row layout: state = connectionId, user_id = owner, expires_at = link expiry
// plus the terminal grace below (so the generic pending_auth sweep in
// auth/oauth.ts does not drop a record a wait_for_connection still needs to
// read as EXPIRED), session_data = the JSON record. Every read and write is
// scoped to the sentinel.
const SENTINEL = "__connect__";

/** Grace window (seconds) a record outlives its link, so a waiter can read the terminal status. */
const PRUNE_GRACE_SECONDS = 3600;

interface StoredRecord {
  integration: string;
  type: ConnectionType;
  status: ConnectionStatus;
  createdAt: number;
  expiresAt: number;
  redeemedAt?: number;
}

interface Row {
  state: string;
  user_id: string;
  session_data: string | null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function decode(row: Row): PendingConnection | undefined {
  let rec: StoredRecord;
  try {
    rec = JSON.parse(row.session_data ?? "") as StoredRecord;
  } catch {
    return undefined;
  }
  if (!rec || typeof rec.integration !== "string") return undefined;
  // A PENDING record past its expiry reads as EXPIRED whether or not the
  // reaper has run yet: the reaper is an optimisation, not the source of truth.
  const status: ConnectionStatus =
    rec.status === "PENDING" && rec.expiresAt <= nowSec() ? "EXPIRED" : rec.status;
  return {
    connectionId: row.state,
    userId: row.user_id,
    integration: rec.integration,
    type: rec.type,
    status,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    ...(rec.redeemedAt !== undefined ? { redeemedAt: rec.redeemedAt } : {}),
  };
}

function encode(rec: PendingConnection): string {
  const stored: StoredRecord = {
    integration: rec.integration,
    type: rec.type,
    status: rec.status,
    createdAt: rec.createdAt,
    expiresAt: rec.expiresAt,
    ...(rec.redeemedAt !== undefined ? { redeemedAt: rec.redeemedAt } : {}),
  };
  return JSON.stringify(stored);
}

async function readRow(connectionId: string): Promise<Row | undefined> {
  return db.get<Row>(
    "SELECT state, user_id, session_data FROM pending_auth WHERE state = ? AND integration = ?",
    [connectionId, SENTINEL]
  );
}

/**
 * Compare-and-swap on the stored JSON: the write lands only if the row still
 * holds exactly what we read. Two processes racing on the same record both
 * read the same text, the database serialises the updates, and exactly one
 * reports a changed row.
 */
async function swap(connectionId: string, before: string, after: string): Promise<boolean> {
  const { changes } = await db.run(
    "UPDATE pending_auth SET session_data = ? WHERE state = ? AND integration = ? AND session_data = ?",
    [after, connectionId, SENTINEL, before]
  );
  return changes === 1;
}

export async function createPending(args: {
  userId: string;
  integration: string;
  type: ConnectionType;
  ttlSeconds: number;
}): Promise<PendingConnection> {
  const createdAt = nowSec();
  const rec: PendingConnection = {
    connectionId: randomUUID(),
    userId: args.userId,
    integration: args.integration,
    type: args.type,
    status: "PENDING",
    createdAt,
    expiresAt: createdAt + args.ttlSeconds,
  };
  await db.run(
    "INSERT INTO pending_auth (state, user_id, integration, expires_at, session_data) VALUES (?, ?, ?, ?, ?)",
    [rec.connectionId, rec.userId, SENTINEL, rec.expiresAt + PRUNE_GRACE_SECONDS, encode(rec)]
  );
  return rec;
}

export async function getPending(connectionId: string): Promise<PendingConnection | undefined> {
  if (typeof connectionId !== "string" || connectionId === "") return undefined;
  const row = await readRow(connectionId);
  return row ? decode(row) : undefined;
}

/**
 * Spend a connect link. Returns the record on the first call and stamps
 * `redeemedAt`; returns null for an unknown, expired, or already-redeemed
 * connectionId. Callers must treat null as "link consumed" and do no work.
 * Single use holds across every worker and replica: the stamp is a
 * compare-and-swap in the database.
 */
export async function redeemPending(connectionId: string): Promise<PendingConnection | null> {
  const row = await readRow(connectionId);
  if (!row || row.session_data === null) return null;
  const rec = decode(row);
  if (!rec) return null;
  if (rec.redeemedAt !== undefined) return null;
  if (rec.status !== "PENDING") return null;
  const redeemed: PendingConnection = { ...rec, redeemedAt: nowSec() };
  if (!(await swap(connectionId, row.session_data, encode(redeemed)))) return null;
  return redeemed;
}

/**
 * Flip the newest PENDING record for (userId, integration) to CONNECTED.
 * Called from the cookie capture handler and the oauth callback handler.
 *
 * Resolution is by (userId, integration), NOT by connectionId, because the
 * capture/oauth-callback handlers don't carry the originating connectionId.
 * "Newest wins" is deliberate: on the rare same-user/same-integration
 * concurrent connect, the most recent attempt is the one marked CONNECTED.
 * Impact is benign (both records belong to the same user/target).
 */
export async function markConnected(userId: string, integration: string): Promise<void> {
  const rows = await db.all<Row>(
    "SELECT state, user_id, session_data FROM pending_auth WHERE integration = ? AND user_id = ?",
    [SENTINEL, userId]
  );
  let newest: { row: Row; rec: PendingConnection } | undefined;
  for (const row of rows) {
    const rec = decode(row);
    if (!rec || rec.integration !== integration || rec.status !== "PENDING") continue;
    if (!newest || rec.createdAt >= newest.rec.createdAt) newest = { row, rec };
  }
  if (!newest || newest.row.session_data === null) return;
  await swap(newest.rec.connectionId, newest.row.session_data, encode({ ...newest.rec, status: "CONNECTED" }));
}

/**
 * Sweep: mark PENDING records past expiry EXPIRED, then drop records whose
 * link expired more than the grace window ago. Every process runs this; the
 * statements are idempotent, so overlapping sweeps are harmless.
 */
export async function reapExpired(): Promise<void> {
  const t = nowSec();
  const rows = await db.all<Row>(
    "SELECT state, user_id, session_data FROM pending_auth WHERE integration = ?",
    [SENTINEL]
  );
  for (const row of rows) {
    const rec = decode(row);
    if (!rec || row.session_data === null) continue;
    // decode() already reports an overdue PENDING as EXPIRED; persist that.
    const storedStatus = (JSON.parse(row.session_data) as StoredRecord).status;
    if (rec.status === "EXPIRED" && storedStatus === "PENDING") {
      await swap(rec.connectionId, row.session_data, encode(rec));
    }
  }
  await db.run("DELETE FROM pending_auth WHERE integration = ? AND expires_at <= ?", [SENTINEL, t]);
}

/** Immediately expire one connection (used by wait_for_connection timeout). */
export async function reapOne(connectionId: string): Promise<void> {
  const row = await readRow(connectionId);
  if (!row || row.session_data === null) return;
  const rec = decode(row);
  if (!rec || rec.status !== "PENDING") return;
  await swap(connectionId, row.session_data, encode({ ...rec, status: "EXPIRED" }));
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapExpired().catch((e) => console.warn("[connect] pending reaper failed:", e));
  }, intervalMs);
  timer.unref?.();
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test-only: wipe every pending connection. */
export async function _clearAll(): Promise<void> {
  await db.run("DELETE FROM pending_auth WHERE integration = ?", [SENTINEL]);
}
