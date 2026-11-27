import { db } from "../db";
import type { DbExecutor } from "../db-adapter";
import { auditLogger } from "../audit/logger";
import { currentAuditContext, runWithAuditContext } from "../audit/context";
import { getKind, type Actor, type InboxRow, type Kind } from "./kinds";
import { sanitizeText } from "./sanitize";
import {
  cancelRequest,
  decideRequest,
  demoteToRejected,
  getRequest,
  insertRequest,
  listByRequester,
  type ApprovalRequest,
} from "./store";

// The rules that must not vary by kind. A kind says who may ask, who may
// decide and what an approval does (kinds.ts); this file makes sure that:
//
// - a non-checker asking about a request id learns nothing: not found, never 403;
// - the maker is never their own checker;
// - exactly one decision wins. The conditional UPDATE (`WHERE status = 'pending'`)
//   is the arbiter; the loser runs nothing;
// - the effect and the status change commit together or not at all;
// - every create and decision leaves an audit row, written after the commit,
//   as the maker (user_id) with the checker as actor_user_id, the same labelling
//   delegated calls use. The row never carries the message or the note.

export type DecideOutcome =
  /** Approved and the effect applied. */
  | "approved"
  /** Approved, but there was nothing left to grant (already satisfied). */
  | "already_satisfied"
  | "rejected"
  /** Could not be granted any more (the subject changed): closed as rejected, nothing applied. */
  | "auto_rejected"
  /** Someone else decided first. Nothing was applied by this call. */
  | "lost";

export type DecideResult = { ok: false } | { ok: true; outcome: DecideOutcome; request: ApprovalRequest };

const NOT_FOUND: DecideResult = { ok: false };

type AuditAction = "APPROVAL_REQUEST" | "APPROVAL_APPROVE" | "APPROVAL_REJECT" | "APPROVAL_CANCEL";

/** Never throws: it runs after the commit, and a failed audit write must not undo a decision. */
async function audit(
  action: AuditAction,
  kind: Kind,
  request: ApprovalRequest,
  outcome: string,
  checkerId?: string
): Promise<void> {
  try {
    const log = () =>
      auditLogger.log({
        user_id: request.requesterId,
        integration: "approvals",
        // describe() and the outcome are fixed vocabulary: never the message or the note.
        tool: `${request.kind} ${kind.describe(request)} (${outcome})`,
        action,
        success: true,
      });
    if (checkerId && checkerId !== request.requesterId) {
      await runWithAuditContext({ ...(currentAuditContext() ?? {}), actor_user_id: checkerId }, log);
    } else {
      await log();
    }
  } catch (err) {
    console.error(
      `[approvals] audit failed: kind=${request.kind} request=${request.id} action=${action}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

export type CreateOutcome =
  /** Always the same answer to the caller, whether or not a request was stored. */
  | "accepted"
  | "rate_limited"
  | "invalid_kind";

/**
 * A person asks (POST /api/approvals). Only for kinds a client may create.
 *
 * The answer is "accepted" whether or not a request was stored: a Space that
 * does not exist, is private, is open to everyone or already shared with the
 * requester all look the same, and the limits are checked first, in the same
 * order, whatever the subject is. Limits are per requester.
 */
export async function createRequest(
  kindName: string,
  requester: Actor,
  subject: string,
  message: unknown
): Promise<CreateOutcome> {
  const kind = getKind(kindName);
  if (!kind || !kind.clientCreatable) return "invalid_kind";
  const text = sanitizeText(message);
  if (!(await kind.withinLimits(requester, subject))) return "rate_limited";
  const check = await kind.canCreate(requester, subject);
  if (!check.ok) return "accepted";
  const id = await insertRequest(db, {
    kind: kind.name,
    subject,
    requesterId: requester.userId,
    message: text,
    payload: check.payload ?? null,
  });
  // null: the same requester already has one open for it. Nothing to add.
  if (id) {
    const created = await getRequest(id);
    if (created) await audit("APPROVAL_REQUEST", kind, created, "requested");
  }
  return "accepted";
}

/**
 * Decide an open request as `actor`.
 *
 * `kinds` is what the calling endpoint serves (admin queue: account.activate;
 * portal: space.access). A request of another kind, an unknown id, one that is
 * not pending, one the actor may not decide and one the actor made themselves
 * are all the same answer: not found.
 */
export async function decide(
  actor: Actor,
  id: string,
  decision: "approve" | "reject",
  opts: { kinds: readonly string[]; note?: unknown }
): Promise<DecideResult> {
  const request = await getRequest(id);
  if (!request || request.status !== "pending" || !opts.kinds.includes(request.kind)) return NOT_FOUND;
  const kind = getKind(request.kind);
  if (!kind) return NOT_FOUND;
  if (!(await kind.canDecide(actor, request))) return NOT_FOUND;
  // After canDecide, so the answer for a non-checker is unchanged.
  if (actor.userId === request.requesterId) return NOT_FOUND;

  const note = sanitizeText(opts.note) || null;

  const settle = async (outcome: DecideOutcome): Promise<DecideResult> => {
    const current = (await getRequest(id)) ?? request;
    if (outcome !== "lost") {
      await audit(
        outcome === "rejected" || outcome === "auto_rejected" ? "APPROVAL_REJECT" : "APPROVAL_APPROVE",
        kind,
        current,
        outcome,
        actor.userId
      );
    }
    return { ok: true, outcome, request: current };
  };

  if (decision === "reject") {
    return settle((await decideRequest(db, id, "rejected", actor.userId, note)) ? "rejected" : "lost");
  }

  const verdict = await kind.validate(request);
  if (verdict.status === "invalid") {
    // The reason is a code from the kind, not user text.
    return settle((await decideRequest(db, id, "rejected", actor.userId, verdict.reason)) ? "auto_rejected" : "lost");
  }
  if (verdict.status === "moot") {
    return settle((await decideRequest(db, id, "approved", actor.userId, note)) ? "already_satisfied" : "lost");
  }

  // The status change and the effect commit together. The conditional UPDATE
  // goes first: on PostgreSQL a concurrent decision blocks on this row, then
  // re-reads it as decided and reports no change, so only the winner applies.
  // If apply throws, the whole transaction (the status change too) rolls back.
  const outcome = await db.transaction(async (tx: DbExecutor): Promise<DecideOutcome> => {
    if (!(await decideRequest(tx, id, "approved", actor.userId, note))) return "lost";
    const applied = await kind.apply(request, tx, actor);
    if (!applied.applied) {
      await demoteToRejected(tx, id, applied.reason);
      return "auto_rejected";
    }
    return "approved";
  });
  return settle(outcome);
}

/** The requester withdraws their own open request. False for anyone else or one already closed. */
export async function cancel(actor: Actor, id: string, kinds: readonly string[]): Promise<boolean> {
  const request = await getRequest(id);
  if (!request || request.requesterId !== actor.userId || !kinds.includes(request.kind)) return false;
  const kind = getKind(request.kind);
  if (!kind || !(await cancelRequest(id, actor.userId))) return false;
  await audit("APPROVAL_CANCEL", kind, { ...request, status: "cancelled" }, "cancelled");
  return true;
}

/** Open requests across `kinds` that `actor` may decide. */
export async function inboxFor(actor: Actor, kinds: readonly string[]): Promise<InboxRow[]> {
  const out: InboxRow[] = [];
  for (const name of kinds) {
    const kind = getKind(name);
    if (kind) out.push(...(await kind.inboxFor(actor)).rows);
  }
  return out;
}

/** The actor's own requests of `kinds`, newest first. */
export function mineFor(userId: string, kinds: readonly string[], limit = 50): Promise<ApprovalRequest[]> {
  return listByRequester(userId, kinds, limit);
}
