import { config } from "../config";
import { verifySession } from "./session";
import { getUserById } from "./users";

// Read at call time, not import time, and tolerate a missing field: many suites
// mock `../src/config` with a hand-built object that has no ADMIN_EMAILS.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (config.ADMIN_EMAILS ?? []).includes(email.trim().toLowerCase());
}

export type AdminResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403 };

// Session JWT only, on purpose. The portal session is the one credential a
// human holds; an API key is what an agent holds, and an admin's agent must not
// inherit admin rights. The email comes from the DB, not the JWT claim, so a
// token minted before an email change cannot outlive it.
export async function resolveAdmin(request: {
  headers: { authorization?: string };
}): Promise<AdminResult> {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return { ok: false, status: 401 };

  let userId: string;
  try {
    userId = (await verifySession(auth.slice(7))).userId;
  } catch {
    return { ok: false, status: 401 };
  }

  const user = await getUserById(userId);
  if (!user) return { ok: false, status: 401 };
  if (!isAdminEmail(user.email)) return { ok: false, status: 403 };
  return { ok: true, userId: user.id, email: user.email as string };
}
