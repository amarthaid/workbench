import { db } from "../db";

/**
 * Whether the user's account is disabled. A user with no row at all is NOT
 * treated as disabled: that keeps tokens signed for ids this table has never
 * seen behaving as they did before accounts could be disabled.
 */
export async function isUserDisabled(userId: string): Promise<boolean> {
  const row = await db.get<{ disabled_at: number | string | null }>(
    "SELECT disabled_at FROM users WHERE id = ?",
    [userId]
  );
  return row?.disabled_at !== null && row?.disabled_at !== undefined;
}

/**
 * Disable or enable a user. Returns true only when the state changed, so a
 * repeated call is a no-op and the original disable time is kept.
 */
export async function setUserDisabled(
  userId: string,
  disabled: boolean,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const { changes } = disabled
    ? await db.run("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL", [nowSeconds, userId])
    : await db.run("UPDATE users SET disabled_at = NULL WHERE id = ? AND disabled_at IS NOT NULL", [userId]);
  return changes > 0;
}
