import { auditLogger } from "../audit/logger";
import { can } from "../permissions/store";
import { db } from "../db";
import { delegationSuspended, type Space, type Visibility } from "./store";

// Delegated access: whether a Space's tool calls may run with its owner's
// connections. See docs/internal/superpowers/specs/2026-11-26-space-delegated-access-design.md.

export type EnableCheck = { ok: true } | { ok: false; code: "DELEGATION_NOT_ALLOWED"; message: string };

/**
 * May `ownerId` turn delegation on for a Space with this (resulting) audience?
 * Only the portal path calls this; an agent credential never enables it.
 */
export async function mayEnableDelegation(ownerId: string, visibility: Visibility): Promise<EnableCheck> {
  if (visibility === "private") {
    return {
      ok: false,
      code: "DELEGATION_NOT_ALLOWED",
      message: "Delegated access needs a Space shared with specific people or everyone signed in.",
    };
  }
  if (!(await can(ownerId, "spaces.delegate_access"))) {
    return { ok: false, code: "DELEGATION_NOT_ALLOWED", message: "An admin has not allowed you to delegate access." };
  }
  return { ok: true };
}

export type DelegationState =
  | { mode: "viewer" }
  | { mode: "owner"; runAs: string }
  | { mode: "off"; reason: "turned_off" | "tools_changed"; message: string };

/**
 * Whose access a call on this Space runs with, decided per call (no cache, so
 * a revoke or a disabled owner takes effect at once). Owner mode that is no
 * longer valid is "off": never a fallback to the viewer's own access.
 */
export async function delegationFor(space: Space): Promise<DelegationState> {
  if (space.accessMode !== "owner") return { mode: "viewer" };
  const off = { mode: "off" as const, reason: "turned_off" as const, message: "This Space's shared access was turned off." };
  if (space.visibility === "private") return off;
  // Read the row directly: a missing owner is off (isUserDisabled treats a
  // missing row as not disabled, which is right for sign-in, not here).
  const owner = await db.get<{ disabled_at: number | string | null }>("SELECT disabled_at FROM users WHERE id = ?", [
    space.ownerId,
  ]);
  if (!owner || (owner.disabled_at !== null && owner.disabled_at !== undefined)) return off;
  if (!(await can(space.ownerId, "spaces.delegate_access"))) return off;
  if (delegationSuspended(space)) {
    return {
      mode: "off",
      reason: "tools_changed",
      message: "This Space's tools changed. The owner needs to confirm them again.",
    };
  }
  return { mode: "owner", runAs: space.ownerId };
}

/**
 * Audit a change of a Space's access mode, as the owner. "on" also covers a
 * re-confirm. `reason` is set when the change was forced (for example the
 * audience was set to only the owner), not chosen.
 */
export async function recordDelegationChange(
  space: Pick<Space, "name">,
  ownerId: string,
  change: "on" | "off",
  reason?: string
): Promise<void> {
  await auditLogger.log({
    user_id: ownerId,
    integration: "spaces",
    tool: `space:${space.name}`,
    action: change === "on" ? "SPACE_DELEGATION_ON" : "SPACE_DELEGATION_OFF",
    success: true,
    ...(reason ? { error: `reason: ${reason}` } : {}),
  });
}
