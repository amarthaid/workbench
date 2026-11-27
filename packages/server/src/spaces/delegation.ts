import { auditLogger } from "../audit/logger";
import { can } from "../permissions/store";
import { db } from "../db";
import { isBlocked } from "../auth/user-status";
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
 * a revoke or a disabled owner takes effect at once). `known.ownerCanDelegate`
 * is the owner's permission when the caller has just read it. Owner mode that is no
 * longer valid is "off": never a fallback to the viewer's own access.
 */
export async function delegationFor(
  space: Space,
  known: { ownerCanDelegate?: boolean } = {}
): Promise<DelegationState> {
  if (space.accessMode !== "owner") return { mode: "viewer" };
  const off = { mode: "off" as const, reason: "turned_off" as const, message: "This Space's shared access was turned off." };
  if (space.visibility === "private") return off;
  // Read the row directly: a missing owner is off (isUserDisabled treats a
  // missing row as not disabled, which is right for sign-in, not here).
  const owner = await db.get<{ status: string | null; disabled_at: number | string | null }>(
    "SELECT status, disabled_at FROM users WHERE id = ?",
    [space.ownerId]
  );
  // Blocked = status <> 'active' OR disabled_at IS NOT NULL (see auth/user-status.ts).
  if (!owner || isBlocked(owner)) return off;
  // A caller that already read the owner's permission passes it in.
  const granted = known.ownerCanDelegate ?? (await can(space.ownerId, "spaces.delegate_access"));
  if (!granted) return off;
  if (delegationSuspended(space)) {
    return {
      mode: "off",
      reason: "tools_changed",
      message: "This Space's tools changed. The owner needs to confirm them again.",
    };
  }
  return { mode: "owner", runAs: space.ownerId };
}

/** Why a mode reset was forced when the audience was set to only the owner. */
export const PRIVATE_REASON = "audience set to only me";

/**
 * Audit a change of a Space's access mode, as the owner. "on" also covers a
 * re-confirm. `reason` is set when the change was forced, not chosen; it goes
 * in the tool text, since the row records a success.
 *
 * Never throws: it runs after the mode is saved, and a failed audit write must
 * not turn a saved change into an error for the owner. The failure is logged.
 */
export async function recordDelegationChange(
  space: Pick<Space, "name">,
  ownerId: string,
  change: "on" | "off",
  reason?: string
): Promise<void> {
  try {
    await auditLogger.log({
      user_id: ownerId,
      integration: "spaces",
      tool: reason ? `space:${space.name} (reason: ${reason})` : `space:${space.name}`,
      action: change === "on" ? "SPACE_DELEGATION_ON" : "SPACE_DELEGATION_OFF",
      success: true,
    });
  } catch (err) {
    console.error(
      `[spaces] audit of delegation change failed: space=${space.name} owner=${ownerId} change=${change}` +
        (reason ? ` reason="${reason}"` : "") +
        `: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Audit a write that turned owner mode off (`modeReset`). An explicit
 * `delegate_access: false` is the owner's choice; otherwise the only cause is
 * a private audience, which is recorded as the reason.
 */
export async function recordModeReset(space: Pick<Space, "name">, ownerId: string, explicitOff: boolean): Promise<void> {
  await recordDelegationChange(space, ownerId, "off", explicitOff ? undefined : PRIVATE_REASON);
}
