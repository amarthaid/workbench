import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { safeRelPath } from "../jots/paths";
import { workspaceRoot } from "./dir";

// The path model here is an ALLOWLIST, by construction: the only input accepted
// is a relative name, and the only path produced is one that resolves inside
// the calling user's directory. There is no list of forbidden patterns, and one
// should not be added — a denylist is a claim that every way out was
// enumerated. Traversal strings belong in the tests, never in the mechanism.

/**
 * Directory name for a user.
 *
 * A hash, not a sanitized id. The browser profiles use
 * `userId.replace(/[^a-zA-Z0-9_-]/g, "_")` (profile-chromium.ts), which is
 * lossy: two ids differing only in sanitized characters collide onto one
 * directory. For a browser profile a collision is a shared login; here it would
 * be one user reading another user's files. Today's ids are UUIDs, which
 * survive that regex intact, so the risk is latent — but isolation that holds
 * only while the id format never changes is not isolation.
 */
export function userKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

export function userWorkspaceDir(userId: string): string {
  return path.join(workspaceRoot(), userKey(userId));
}

/**
 * Absolute path for a user's file, or null if the name is not acceptable.
 *
 * Two guards, deliberately: `safeRelPath` judges the input, the prefix check
 * judges the result. Callers pass a relative name and never an absolute path —
 * an absolute path from a tool argument would be an arbitrary-file primitive.
 *
 * Pure path arithmetic. This is what names a file being CREATED; anything
 * about to read bytes wants `resolveExistingFile`.
 */
export function userFilePath(userId: string, name: string): string | null {
  const rel = safeRelPath(name);
  if (!rel) return null;
  const base = userWorkspaceDir(userId);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/**
 * The same, for a file that already exists and is about to be read.
 *
 * Adds the one check path arithmetic cannot make: `path.resolve` is string
 * manipulation and does not follow symlinks, so a symlink sitting inside the
 * workspace and pointing at the token database satisfies `userFilePath` and
 * still escapes. Nothing here writes symlinks, so this is defence in depth —
 * but the workspace lives on a volume other things can reach, and the failure
 * mode is silent exfiltration through `browser_upload_file`, which hands an
 * absolute path to a process that uploads whatever it is given.
 *
 * Returns null for a missing file too. A caller cannot distinguish "outside the
 * workspace" from "not there", and should not be able to.
 */
export async function resolveExistingFile(userId: string, name: string): Promise<string | null> {
  const target = userFilePath(userId, name);
  if (!target) return null;
  // realpath the base as well: on macOS /tmp is itself a symlink to
  // /private/tmp, so comparing a resolved target against an unresolved base
  // rejects every file in a tmpdir-backed test.
  const base = await realpath(userWorkspaceDir(userId)).catch(() => null);
  const real = await realpath(target).catch(() => null);
  if (!base || !real) return null;
  if (real !== base && !real.startsWith(base + path.sep)) return null;
  return real;
}
