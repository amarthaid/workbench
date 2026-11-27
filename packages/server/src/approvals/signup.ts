import crypto from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { isAdminEmail } from "../auth/admin";
import { getUserStatus, isUserDisabled, setUserStatus } from "../auth/user-status";
import { ACCOUNT_ACTIVATE, PENDING_SIGNUP_CAP } from "./kinds";
import {
  closeOpenForSubject,
  countPending,
  insertRequest,
  latestRequestFor,
  pendingRequestFor,
} from "./store";

// Sign-in side of account.activate: the Google and Keycloak callbacks create
// users and settle their status here, so the rules live in one place.

/** After a rejection, a sign-in this much later opens a fresh request. */
export const REREQUEST_AFTER_SECONDS = 24 * 60 * 60;

/**
 * The person may not sign in yet: their account waits for an admin
 * (`declined: false`) or was declined recently (`declined: true`). The
 * callbacks turn this into a redirect to the portal login page; the rejection
 * note is never part of it.
 */
export class AccountPendingError extends Error {
  constructor(readonly declined: boolean) {
    super(declined ? "Account declined" : "Account pending");
    this.name = "AccountPendingError";
  }
}

function approvalRequired(email: string): boolean {
  // Admins always sign in: if they could be held, nobody could approve anything.
  return config.REQUIRE_SIGNUP_APPROVAL === true && !isAdminEmail(email);
}

async function auditSignup(userId: string, tool: string): Promise<void> {
  try {
    await auditLogger.log({
      user_id: userId,
      integration: "approvals",
      tool,
      action: "APPROVAL_REQUEST",
      success: true,
    });
  } catch (err) {
    console.error(`[approvals] audit failed: user=${userId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create the user for a first sign-in. With `REQUIRE_SIGNUP_APPROVAL` on (and
 * an email that is not an admin's) the user is created `pending` and its
 * `account.activate` request in the same transaction, so there is never a
 * pending user without a request. `disabled_at` is written too while an older
 * worker may still be running: it only reads that column.
 *
 * Past the pending cap nothing is created and the person sees the pending
 * message; a later sign-in tries again.
 */
export async function createUserForSignup(input: {
  email: string;
  provider: "google" | "keycloak";
  sub: string;
}): Promise<{ id: string; email: string; pending: boolean }> {
  const id = crypto.randomUUID();
  const column = input.provider === "google" ? "google_sub" : "keycloak_sub";
  const pending = approvalRequired(input.email);
  await db.transaction(async (tx) => {
    if (!pending) {
      await tx.run(`INSERT INTO users (id, email, ${column}) VALUES (?, ?, ?)`, [id, input.email, input.sub]);
      return;
    }
    if ((await countPending(ACCOUNT_ACTIVATE, tx)) >= PENDING_SIGNUP_CAP) throw new AccountPendingError(false);
    await tx.run(`INSERT INTO users (id, email, ${column}, status, disabled_at) VALUES (?, ?, ?, 'pending', ?)`, [
      id,
      input.email,
      input.sub,
      Math.floor(Date.now() / 1000),
    ]);
    await insertRequest(tx, { kind: ACCOUNT_ACTIVATE, subject: id, requesterId: id });
  });
  if (pending) await auditSignup(id, "account.activate account activation (requested)");
  return { id, email: input.email, pending };
}

/**
 * Runs on every sign-in, after the user is resolved (created, found, linked).
 * Returns when the user may sign in; throws AccountPendingError for a pending
 * account and Error("Account disabled") for a disabled one.
 */
export async function settleSignInStatus(user: { id: string; email: string | null }): Promise<void> {
  let status = await getUserStatus(user.id);
  // An admin who was added to ADMIN_EMAILS after signing up is released here.
  if (status === "pending" && isAdminEmail(user.email)) {
    await db.transaction(async (tx) => {
      if (await setUserStatus(user.id, "active", { from: "pending" }, tx)) {
        await closeOpenForSubject(tx, ACCOUNT_ACTIVATE, user.id, "approved", user.id, "admin_email");
      }
    });
    status = await getUserStatus(user.id);
  }
  if (status === "pending") throw new AccountPendingError(await ensurePendingRequest(user.id));
  // Disabled, or an active row an older worker disabled (fails closed).
  if (await isUserDisabled(user.id)) throw new Error("Account disabled");
}

/**
 * A pending user always has an open request (self-heals one that is missing).
 * Returns true when the latest request was rejected less than a day ago: the
 * person is shown "declined" and no new request is opened yet.
 */
async function ensurePendingRequest(userId: string): Promise<boolean> {
  if (await pendingRequestFor(ACCOUNT_ACTIVATE, userId, userId)) return false;
  const latest = await latestRequestFor(ACCOUNT_ACTIVATE, userId, userId);
  const now = Math.floor(Date.now() / 1000);
  if (latest?.status === "rejected" && latest.decidedAt !== null && now - latest.decidedAt < REREQUEST_AFTER_SECONDS) {
    return true;
  }
  if ((await countPending(ACCOUNT_ACTIVATE)) >= PENDING_SIGNUP_CAP) return false;
  // ON CONFLICT DO NOTHING: two sign-ins at once leave one request.
  if (await insertRequest(db, { kind: ACCOUNT_ACTIVATE, subject: userId, requesterId: userId })) {
    await auditSignup(userId, "account.activate account activation (requested)");
  }
  return false;
}
