import { db } from "../db";
import type { DbExecutor } from "../db-adapter";

/**
 * Account lifecycle. `status` is the authority; `disabled_at` is written in
 * step with it for one release so a worker still running the previous version
 * (which reads only `disabled_at`) keeps blocking the same people. Drop the
 * `disabled_at` clause of `isBlocked` in the release that drops the column.
 */
export type UserStatus = "active" | "pending" | "disabled";

interface StatusRow {
  status: string | null;
  disabled_at: number | string | null;
}

/**
 * Blocked means `status <> 'active' OR disabled_at IS NOT NULL`. The second
 * clause fails closed during the dual-write release: an old worker's disable
 * (which writes only `disabled_at`) is honoured, and an old worker's enable of
 * a pending or disabled user does not unblock it.
 */
export function isBlocked(row: StatusRow): boolean {
  const status = row.status ?? "active";
  return status !== "active" || (row.disabled_at !== null && row.disabled_at !== undefined);
}

/** The effective status of a row (an active row with `disabled_at` set reads as disabled). */
export function effectiveStatus(row: StatusRow): UserStatus {
  const status = row.status ?? "active";
  if (status === "pending") return "pending";
  return isBlocked(row) ? "disabled" : "active";
}

export async function getUserStatus(
  userId: string,
  executor: DbExecutor = db
): Promise<UserStatus | "missing"> {
  const row = await executor.get<StatusRow>("SELECT status, disabled_at FROM users WHERE id = ?", [userId]);
  return row ? effectiveStatus(row) : "missing";
}

/**
 * Whether the user may not sign in or use any credential. A user with no row
 * at all is NOT blocked: that keeps tokens signed for ids this table has never
 * seen behaving as they did before accounts could be disabled.
 */
export async function isUserDisabled(userId: string, executor: DbExecutor = db): Promise<boolean> {
  const row = await executor.get<StatusRow>("SELECT status, disabled_at FROM users WHERE id = ?", [userId]);
  return row ? isBlocked(row) : false;
}

/**
 * Move a user to `status` with one guarded statement. Returns true only when
 * the row changed, so a repeat is a no-op and the first `disabled_at` is kept.
 *
 * - `active` clears `disabled_at`. With `from: "pending"` it only fires on a
 *   still-pending user (approve): zero changes means an admin disabled the
 *   user in between and nothing must be applied.
 * - `pending` and `disabled` set `disabled_at` (dual write) and keep an
 *   earlier value.
 *
 * Never opens a transaction: pass the executor of the one you are in.
 */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  opts: { from?: UserStatus; nowSeconds?: number } = {},
  executor: DbExecutor = db
): Promise<boolean> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (status === "active") {
    const guard = opts.from ? "status = ?" : "(status <> 'active' OR disabled_at IS NOT NULL)";
    const { changes } = await executor.run(
      `UPDATE users SET status = 'active', disabled_at = NULL WHERE id = ? AND ${guard}`,
      opts.from ? [userId, opts.from] : [userId]
    );
    return changes > 0;
  }
  const from = opts.from ? " AND status = ?" : " AND (status <> ? OR disabled_at IS NULL)";
  const { changes } = await executor.run(
    `UPDATE users SET status = ?, disabled_at = COALESCE(disabled_at, ?) WHERE id = ?${from}`,
    [status, now, userId, opts.from ?? status]
  );
  return changes > 0;
}

/**
 * Disable or enable a user. Returns true only when the state changed, so a
 * repeated call is a no-op and the original disable time is kept.
 */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  executor: DbExecutor = db
): Promise<boolean> {
  return setUserStatus(userId, disabled ? "disabled" : "active", { nowSeconds }, executor);
}
