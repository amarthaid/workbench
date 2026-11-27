import { db } from "../db";
import type { DbExecutor } from "../db-adapter";
import { isAdminEmail } from "../auth/admin";
import { getUserStatus, isUserDisabled, setUserStatus } from "../auth/user-status";
import { changeShares, getSpace, hasFiles, isSharedWith, normalizeEmail } from "../spaces/store";
import {
  COLUMNS_R,
  countRecentByRequester,
  fromRow,
  listPendingByRequester,
  pagePending,
  type ApprovalRequest,
} from "./store";

// The registry of things people can ask for. A kind is the domain half of
// maker-checker: who may ask, who may decide, whether the ask still makes
// sense, and what an approval does. Everything that must not vary by kind
// (maker is not checker, one winner per request, 404 for non-checkers, audit)
// lives in engine.ts.

export interface Actor {
  userId: string;
  email: string | null;
}

/** One row of someone's inbox: a request they may decide. */
export interface InboxRow {
  request: ApprovalRequest;
  requesterEmail: string | null;
  /** The approval lends the owner's connections to the requester (delegated Space). */
  delegated: boolean;
}

export type CreateCheck = { ok: true; payload?: Record<string, unknown> } | { ok: false };

/**
 * ok: still meaningful, apply it. moot: already satisfied, reported as an
 * approved no-op. invalid: cannot be granted any more, auto-rejected with
 * `reason` (a short code, never user text).
 */
export type Validation = { status: "ok" } | { status: "moot" } | { status: "invalid"; reason: string };

/** `applied: false` closes the request as rejected with `reason`; the effect did not happen. */
export type ApplyResult = { applied: true } | { applied: false; reason: string };

export interface Kind {
  name: string;
  /** May a signed-in person open one through POST /api/approvals? */
  clientCreatable: boolean;
  /**
   * Request-count limits for this requester and subject, true when under them.
   * Runs for every create, whatever the subject turns out to be, so a refusal
   * cannot reveal whether the subject exists.
   */
  withinLimits(requester: Actor, subject: string): Promise<boolean>;
  /** May this person open one for this subject? Also false when it would be a no-op. */
  canCreate(requester: Actor, subject: string): Promise<CreateCheck>;
  /** Open requests this actor may decide. `page` is for kinds whose queue can be long. */
  inboxFor(actor: Actor, page?: { limit: number; cursor?: string }): Promise<{ rows: InboxRow[]; next: string | null }>;
  canDecide(actor: Actor, request: ApprovalRequest): Promise<boolean>;
  validate(request: ApprovalRequest): Promise<Validation>;
  /**
   * The effect of an approval. Runs inside the engine's transaction: every
   * statement goes through `tx`, and anything it calls takes `tx` too and never
   * opens a transaction of its own (nesting hangs on SQLite and splits the
   * commit on PostgreSQL).
   */
  apply(request: ApprovalRequest, tx: DbExecutor, actor: Actor): Promise<ApplyResult>;
  /** One line for audit rows. Never contains the requester's message or a note. */
  describe(request: ApprovalRequest): string;
  /** A short label for the subject, for lists. */
  subjectLabel(request: ApprovalRequest): Promise<string>;
}

// ---- account.activate -------------------------------------------------------

export const ACCOUNT_ACTIVATE = "account.activate";

/** Pending sign-ups beyond this are not recorded (the person still sees "pending"). */
export const PENDING_SIGNUP_CAP = 200;

export const accountActivate: Kind = {
  name: ACCOUNT_ACTIVATE,
  // Server-created at sign-in only.
  clientCreatable: false,
  withinLimits: async () => true,
  canCreate: async () => ({ ok: false }),
  async inboxFor(actor, page = { limit: 50 }) {
    if (!isAdminEmail(actor.email)) return { rows: [], next: null };
    const { rows, next } = await pagePending(ACCOUNT_ACTIVATE, page.limit, page.cursor);
    return {
      rows: rows.map(({ requesterEmail, ...request }) => ({ request, requesterEmail, delegated: false })),
      next,
    };
  },
  // Admins only (the ADMIN_EMAILS list), read from the database by the gate.
  canDecide: async (actor) => isAdminEmail(actor.email),
  async validate(request) {
    const status = await getUserStatus(request.subject);
    if (status === "pending") return { status: "ok" };
    if (status === "active") return { status: "moot" };
    return { status: "invalid", reason: "account_unavailable" };
  },
  async apply(request, tx) {
    // Guarded: only a still-pending user is activated. Zero changes means an
    // admin disabled the account between validate and now.
    const changed = await setUserStatus(request.subject, "active", { from: "pending" }, tx);
    return changed ? { applied: true } : { applied: false, reason: "account_unavailable" };
  },
  describe: () => "account activation",
  async subjectLabel(request) {
    const row = await db.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [request.subject]);
    return row?.email ?? request.subject;
  },
};

// ---- space.access -----------------------------------------------------------

export const SPACE_ACCESS = "space.access";

const DAY = 86_400;
/** Open requests per requester (requests on Spaces that no longer exist do not count). */
export const SPACE_ACCESS_MAX_OPEN = 5;
/** Per requester and Space, in 24 hours, counting rejected and cancelled ones. */
export const SPACE_ACCESS_MAX_PER_SPACE_DAY = 3;
/** Per requester, in 24 hours, over every Space. */
export const SPACE_ACCESS_MAX_PER_DAY = 20;

/** The Space this request was made for, as it is now. Null when it is gone or is a different Space under a reused name. */
async function liveSpace(request: ApprovalRequest) {
  const space = await getSpace(request.subject);
  if (!space) return null;
  const pinned = Number(request.payload?.space_created_at);
  return Number.isFinite(pinned) && pinned === space.createdAt ? space : null;
}

interface InboxQueryRow {
  requester_email: string | null;
  space_created_at: number | string;
  space_access_mode: string | null;
  [column: string]: unknown;
}

/** Open requests for Spaces `ownerId` owns that are shared with specific people. */
async function ownerInbox(ownerId: string): Promise<InboxRow[]> {
  const rows = await db.all<InboxQueryRow>(
    `SELECT ${COLUMNS_R}, u.email AS requester_email,
            s.created_at AS space_created_at, s.access_mode AS space_access_mode
       FROM approval_requests r
       JOIN spaces s ON s.name = r.subject
       LEFT JOIN users u ON u.id = r.requester_id
      WHERE r.kind = ? AND r.status = 'pending' AND s.owner_id = ? AND s.visibility = 'users'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 200`,
    [SPACE_ACCESS, ownerId]
  );
  const out: InboxRow[] = [];
  for (const row of rows) {
    const request = fromRow(row as unknown as Parameters<typeof fromRow>[0]);
    // A recreated Space under the same name never inherits old requests.
    if (Number(request.payload?.space_created_at) !== Number(row.space_created_at)) continue;
    out.push({ request, requesterEmail: row.requester_email ?? null, delegated: row.space_access_mode === "owner" });
  }
  return out;
}

/** Open request counts per Space name, for the owner's Spaces list. */
export async function pendingRequestCounts(ownerId: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const { request } of await ownerInbox(ownerId)) {
    counts.set(request.subject, (counts.get(request.subject) ?? 0) + 1);
  }
  return counts;
}

export const spaceAccess: Kind = {
  name: SPACE_ACCESS,
  clientCreatable: true,

  // All three counts always run (no early exit), so the work does not depend
  // on the outcome.
  async withinLimits(requester, subject) {
    const since = Math.floor(Date.now() / 1000) - DAY;
    const [perDay, perSpace, open] = await Promise.all([
      countRecentByRequester(SPACE_ACCESS, requester.userId, since),
      countRecentByRequester(SPACE_ACCESS, requester.userId, since, subject),
      (async () => {
        let live = 0;
        for (const r of await listPendingByRequester(SPACE_ACCESS, requester.userId)) {
          if (await liveSpace(r)) live++;
        }
        return live;
      })(),
    ]);
    return perDay < SPACE_ACCESS_MAX_PER_DAY && perSpace < SPACE_ACCESS_MAX_PER_SPACE_DAY && open < SPACE_ACCESS_MAX_OPEN;
  },

  // A request exists only for a live Space shared with specific people, that
  // has files, where the requester is neither the owner nor already listed.
  // Anything else is "no request", and the caller answers the same either way.
  async canCreate(requester, subject) {
    const space = await getSpace(subject);
    const email = requester.email ? normalizeEmail(requester.email) : null;
    const [shared, ownerStatus] = await Promise.all([
      space && email ? isSharedWith(space.name, email) : Promise.resolve(true),
      space ? getUserStatus(space.ownerId) : Promise.resolve("missing" as const),
    ]);
    if (!space || !email || shared) return { ok: false };
    if (space.visibility !== "users" || !hasFiles(space.name)) return { ok: false };
    if (space.ownerId === requester.userId || ownerStatus !== "active") return { ok: false };
    return { ok: true, payload: { space_created_at: space.createdAt } };
  },

  async inboxFor(actor) {
    return { rows: await ownerInbox(actor.userId), next: null };
  },

  // The owner of the very Space the request was made for. Admins have no path.
  async canDecide(actor, request) {
    const space = await liveSpace(request);
    return !!space && space.ownerId === actor.userId;
  },

  async validate(request) {
    const space = await liveSpace(request);
    if (!space) return { status: "invalid", reason: "space_gone" };
    if (space.visibility === "private") return { status: "invalid", reason: "space_private" };
    // Open to everyone signed in: the request has nothing left to grant.
    if (space.visibility === "org") return { status: "moot" };
    if ((await getUserStatus(space.ownerId)) !== "active") return { status: "invalid", reason: "owner_unavailable" };
    const requester = await db.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [
      request.requesterId,
    ]);
    if (!requester?.email || (await isUserDisabled(request.requesterId))) {
      return { status: "invalid", reason: "requester_unavailable" };
    }
    if (await isSharedWith(space.name, normalizeEmail(requester.email))) return { status: "moot" };
    return { status: "ok" };
  },

  // Through the same writer the Sharing endpoint uses, handed our transaction.
  // Idempotent (ON CONFLICT DO NOTHING). The engine's APPROVAL_APPROVE row is
  // the audit record of the grant.
  async apply(request, tx, actor) {
    const requester = await tx.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [
      request.requesterId,
    ]);
    if (!requester?.email) return { applied: false, reason: "requester_unavailable" };
    const result = await changeShares(request.subject, actor.userId, { add: [requester.email] }, false, tx);
    return result === "forbidden" ? { applied: false, reason: "space_gone" } : { applied: true };
  },

  describe: (request) => `space:${request.subject}`,
  subjectLabel: async (request) => request.subject,
};

// ---- registry ---------------------------------------------------------------

const KINDS: Record<string, Kind> = {
  [ACCOUNT_ACTIVATE]: accountActivate,
  [SPACE_ACCESS]: spaceAccess,
};

export function getKind(name: string): Kind | undefined {
  return Object.prototype.hasOwnProperty.call(KINDS, name) ? KINDS[name] : undefined;
}

/** Test seam: add a kind (a fake one for the engine suite). Returns an undo. */
export function _registerKindForTest(kind: Kind): () => void {
  KINDS[kind.name] = kind;
  return () => {
    delete KINDS[kind.name];
  };
}
