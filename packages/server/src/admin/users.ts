import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { isAdminEmail } from "../auth/admin";
import { clearApiKey } from "../auth/users";
import { setUserDisabled } from "../auth/user-status";
import type { AdminActor } from "../api/admin-scope";

export interface AdminUserRow {
  id: string;
  email: string | null;
  created_at: number;
  disabled_at: number | null;
  has_api_key: boolean;
  connection_count: number;
  custom_app_count: number;
  last_activity: number | null;
}

export type UserActionResult =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: "user_not_found" | "cannot_disable_self" | "cannot_disable_admin" };

// Explicit columns, never SELECT *: api_key_hash, api_key_sha and api_key_enc
// live on this table and must not reach a response.
export async function listUsers(limit = 500): Promise<{ users: AdminUserRow[]; total: number }> {
  const rows = await db.all<Record<string, unknown>>(
    `SELECT u.id, u.email, u.created_at, u.disabled_at,
            CASE WHEN u.api_key_hash IS NOT NULL THEN 1 ELSE 0 END AS has_api_key,
            (SELECT COUNT(*) FROM connections c WHERE c.user_id = u.id) AS connection_count,
            (SELECT COUNT(*) FROM custom_apps a WHERE a.user_id = u.id) AS custom_app_count,
            (SELECT MAX(l.created_at) FROM audit_log l WHERE l.user_id = u.id) AS last_activity
       FROM users u
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ?`,
    [limit]
  );
  const count = await db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM users");
  const orNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    users: rows.map((r) => ({
      id: String(r.id),
      email: (r.email as string | null) ?? null,
      created_at: Number(r.created_at),
      disabled_at: orNull(r.disabled_at),
      has_api_key: Number(r.has_api_key) === 1,
      connection_count: Number(r.connection_count),
      custom_app_count: Number(r.custom_app_count),
      last_activity: orNull(r.last_activity),
    })),
    total: Number(count?.n ?? 0),
  };
}

type Target = { id: string; email: string | null };

async function findUser(id: string): Promise<Target | undefined> {
  return db.get<Target>("SELECT id, email FROM users WHERE id = ?", [id]);
}

async function audit(
  actor: AdminActor,
  action: "ADMIN_USER_DISABLE" | "ADMIN_USER_ENABLE" | "ADMIN_KEY_REVOKE",
  verb: string,
  target: Target
): Promise<void> {
  await auditLogger.log({
    user_id: actor.userId,
    action,
    tool: `admin.user.${verb} → ${target.email ?? target.id}`,
    success: true,
  });
}

const NOT_FOUND: UserActionResult = { ok: false, status: 404, error: "user_not_found" };

export async function disableUser(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  // You cannot lock yourself out, and admins are managed by ADMIN_EMAILS, not here.
  if (target.id === actor.userId) return { ok: false, status: 400, error: "cannot_disable_self" };
  if (isAdminEmail(target.email)) return { ok: false, status: 400, error: "cannot_disable_admin" };

  await setUserDisabled(target.id, true);
  // A refresh token the user already holds must not mint fresh access tokens.
  await db.run("DELETE FROM oauth_refresh_tokens WHERE user_id = ?", [target.id]);
  await audit(actor, "ADMIN_USER_DISABLE", "disable", target);
  return { ok: true };
}

export async function enableUser(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  await setUserDisabled(target.id, false);
  await audit(actor, "ADMIN_USER_ENABLE", "enable", target);
  return { ok: true };
}

export async function revokeUserKey(actor: AdminActor, id: string): Promise<UserActionResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  await clearApiKey(target.id);
  await audit(actor, "ADMIN_KEY_REVOKE", "revoke-key", target);
  return { ok: true };
}
