// The user's email for audit events, cached briefly so a busy agent does not
// add a users lookup to every tool call. An email change shows up within
// EMAIL_TTL_MS; a lookup failure records null rather than failing the call.

import { db } from "../db";

const EMAIL_TTL_MS = 5 * 60_000;
const CACHE_MAX = 5_000;
const cache = new Map<string, { email: string | null; at: number }>();

export async function auditUserEmail(userId: string): Promise<string | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < EMAIL_TTL_MS) return hit.email;
  let email: string | null = null;
  try {
    const row = await db.get<{ email: string | null }>("SELECT email FROM users WHERE id = ?", [userId]);
    email = row?.email ?? null;
  } catch {
    return hit?.email ?? null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(userId, { email, at: Date.now() });
  return email;
}

/**
 * The actor of a delegated call and their email, or nothing when there is no
 * actor. Shared by audit events and request log lines.
 */
export async function auditActorFields(
  actorUserId: string | undefined
): Promise<{ actor_user_id?: string; actor_email?: string | null }> {
  if (!actorUserId) return {};
  return { actor_user_id: actorUserId, actor_email: await auditUserEmail(actorUserId) };
}

/** Test seam. */
export function resetAuditEmailCache(): void {
  cache.clear();
}
