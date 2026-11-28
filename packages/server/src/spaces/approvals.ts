import crypto from "node:crypto";
import { effectOf } from "@a-workbench/shared";
import { auditLogger } from "../audit/logger";
import { db } from "../db";
import { registry, type PluginTool } from "../plugins/registry";
import { isInternalIntegration } from "../plugins/internal-names";
import { consentHash, getConsentRow, getSpace, type Space } from "./store";

// Per-tool approval modes for Spaces. See
// docs/internal/superpowers/specs/2026-11-27-space-tool-approvals-design.md.

export type ApprovalMode = "auto" | "ask";
/** Only the choices that differ from a tool's default are stored. */
export type ApprovalRows = Record<string, ApprovalMode>;

export interface ApprovalChange {
  tool: string;
  from: ApprovalMode;
  to: ApprovalMode;
}

export async function getApprovalRows(spaceName: string, userId: string): Promise<ApprovalRows> {
  const rows = await db.all<{ tool: string; mode: string }>(
    "SELECT tool, mode FROM space_tool_approvals WHERE space_name = ? AND user_id = ?",
    [spaceName, userId]
  );
  const out: ApprovalRows = {};
  for (const r of rows) if (r.mode === "auto" || r.mode === "ask") out[r.tool] = r.mode;
  return out;
}

/**
 * Apply `next` for one user in one transaction and return the changes that took
 * effect. A tool set back to its default (`defaults[tool]`) loses its row.
 */
export async function writeApprovals(
  spaceName: string,
  userId: string,
  next: Record<string, ApprovalMode>,
  defaults: Record<string, ApprovalMode>
): Promise<ApprovalChange[]> {
  return db.transaction(async (tx) => {
    const current = await tx.all<{ tool: string; mode: string }>(
      "SELECT tool, mode FROM space_tool_approvals WHERE space_name = ? AND user_id = ?",
      [spaceName, userId]
    );
    const rows = new Map(current.map((r) => [r.tool, r.mode as ApprovalMode]));
    const changes: ApprovalChange[] = [];
    for (const [tool, to] of Object.entries(next)) {
      const from = rows.get(tool) ?? defaults[tool];
      if (from === to) continue;
      changes.push({ tool, from, to });
      if (to === defaults[tool]) {
        await tx.run("DELETE FROM space_tool_approvals WHERE space_name = ? AND user_id = ? AND tool = ?", [
          spaceName,
          userId,
          tool,
        ]);
      } else {
        await tx.run(
          `INSERT INTO space_tool_approvals (space_name, user_id, tool, mode, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (space_name, user_id, tool) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
          [spaceName, userId, tool, to, Date.now()]
        );
      }
    }
    return changes;
  });
}

/**
 * Audit a change of the owner's approvals in a Space whose stored access mode
 * is "owner" (there they are the policy for everyone). One row per request:
 * `space:<name> approvals: <tool>=<mode>,...` in tool order. The caller checks
 * that the change is auditable; nothing is written for an empty list.
 *
 * Never throws: it runs after the change is saved, and a failed audit write
 * must not turn a saved change into an error. The failure is logged.
 */
export async function recordApprovalChange(
  space: Pick<Space, "name">,
  ownerId: string,
  changes: ApprovalChange[]
): Promise<void> {
  if (changes.length === 0) return;
  const text = [...changes]
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0))
    .map((c) => `${c.tool}=${c.to}`)
    .join(",");
  try {
    await auditLogger.log({
      user_id: ownerId,
      integration: "spaces",
      tool: `space:${space.name} approvals: ${text}`,
      action: "SPACE_APPROVAL_CHANGE",
      success: true,
    });
  } catch (err) {
    console.error(
      `[spaces] audit of approval change failed: space=${space.name} owner=${ownerId}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

/**
 * Audit a portal delete of a Space by its owner. Never throws: the Space is
 * already gone, and a failed audit write must not turn that into an error.
 */
export async function recordSpaceDelete(space: Pick<Space, "name">, ownerId: string): Promise<void> {
  try {
    await auditLogger.log({
      user_id: ownerId,
      integration: "spaces",
      tool: `space:${space.name}`,
      action: "SPACE_DELETE",
      success: true,
    });
  } catch (err) {
    console.error(
      `[spaces] audit of delete failed: space=${space.name} owner=${ownerId}: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// ---- policy ----------------------------------------------------------------

/** A tool the Space cannot use: internal integrations never run from a Space. */
export function isInternalTool(tool: PluginTool): boolean {
  return isInternalIntegration(tool.integration);
}

/**
 * True when this viewer's calls follow the owner's policy: the stored access
 * mode is "owner" and the viewer is not the owner. It uses the stored mode, not
 * whether delegation is in effect, so a paused delegation still follows the
 * owner and needs no permission lookup.
 */
export function delegatedFor(space: Space, viewerId: string): boolean {
  return space.accessMode === "owner" && viewerId !== space.ownerId;
}

/** Whose approval rows decide for this viewer. */
export function policySource(space: Space, viewerId: string): string {
  return delegatedFor(space, viewerId) ? space.ownerId : viewerId;
}

/** Read the policy rows that apply to this viewer. Callers read once per request. */
export async function policyRows(space: Space, viewerId: string): Promise<ApprovalRows> {
  return getApprovalRows(space.name, policySource(space, viewerId));
}

/** The mode a tool has with no row: write runs, anything else non-read asks. Reads have none. */
export function defaultMode(tool: PluginTool): ApprovalMode | null {
  const effect = effectOf(tool);
  if (effect === "read") return null;
  return effect === "write" ? "auto" : "ask";
}

function usableTool(toolName: string): PluginTool | null {
  const tool = registry.getTool(toolName);
  if (!tool || !registry.getIntegration(tool.integration) || isInternalTool(tool)) return null;
  return tool;
}

/** Effective mode: null for a read tool (never asks), "ask" for a missing or internal one. */
export function approvalFor(_space: Space, _viewerId: string, toolName: string, rows: ApprovalRows): ApprovalMode | null {
  const tool = usableTool(toolName);
  if (!tool) return "ask";
  const def = defaultMode(tool);
  if (def === null) return null;
  return rows[toolName] ?? def;
}

/**
 * Sorted names of the tools that run without asking. For a delegated viewer,
 * tools that cannot be delegated are left out: they never run for them.
 */
export function autoSet(space: Space, viewerId: string, rows: ApprovalRows): string[] {
  const delegated = delegatedFor(space, viewerId);
  const out: string[] = [];
  for (const name of space.tools) {
    if (approvalFor(space, viewerId, name, rows) !== "auto") continue;
    if (delegated && registry.getTool(name)?.delegable === false) continue;
    out.push(name);
  }
  return out.sort();
}

/** Whether this viewer may change the tool's mode: not a read or missing tool, not a delegated viewer. */
export function approvalEditable(space: Space, viewerId: string, toolName: string): boolean {
  const tool = usableTool(toolName);
  if (!tool || defaultMode(tool) === null) return false;
  return !delegatedFor(space, viewerId);
}

// ---- consent ---------------------------------------------------------------

/**
 * The hash a viewer is shown and sends back to approve. A delegated viewer's
 * also covers the auto set on the screen, so a policy change between loading
 * the screen and approving is a CONSENT_CHANGED. For everyone else it is the
 * plain consentHash: their modes are their own.
 */
export function shownConsentHash(space: Space, viewerId: string, auto: string[]): string {
  const base = consentHash(space, viewerId);
  if (!delegatedFor(space, viewerId)) return base;
  return crypto.createHash("sha256").update(JSON.stringify([base, auto])).digest("hex");
}

/** What a delegated consent that predates auto_tools approved: today's delegable write tools. */
export function legacyApprovedSet(space: Space): string[] {
  const out: string[] = [];
  for (const name of space.tools) {
    const tool = usableTool(name);
    if (tool && effectOf(tool) === "write" && tool.delegable !== false) out.push(name);
  }
  return out.sort();
}

export type ConsentCheck = { consented: boolean; reason?: "tools" | "approvals" | "page" };

/**
 * True when something that would otherwise ask first runs without asking for
 * this viewer: a tool in their auto set whose default is not auto (a destructive
 * or unclassified tool set to Always allow, or Allow all over one). For a
 * delegated viewer the set follows the owner's rows and leaves out tools that
 * cannot be delegated. Such a person approves again when the Space changes.
 */
export function isElevated(space: Space, viewerId: string, rows: ApprovalRows): boolean {
  return autoSet(space, viewerId, rows).some((name) => {
    const tool = usableTool(name);
    return !!tool && defaultMode(tool) !== "auto";
  });
}

/**
 * Has this viewer approved what they would run now? The stored hash must match
 * consentHash; a delegated viewer must also have approved every tool that now
 * runs without asking. Tightening shrinks the set and stays approved;
 * loosening adds a tool and asks again. An elevated person (see isElevated)
 * must also have approved the Space as it is now: any change to the Space
 * (a page upload, a tool list change) since their approval asks again.
 */
export async function checkConsent(space: Space, viewerId: string, rows: ApprovalRows): Promise<ConsentCheck> {
  const row = await getConsentRow(space.name, viewerId);
  if (!row) return { consented: false };
  if (row.hash !== consentHash(space, viewerId)) return { consented: false, reason: "tools" };
  if (delegatedFor(space, viewerId)) {
    const approved = new Set(row.autoTools ?? legacyApprovedSet(space));
    for (const name of autoSet(space, viewerId, rows)) {
      if (!approved.has(name)) return { consented: false, reason: "approvals" };
    }
  }
  if (isElevated(space, viewerId, rows) && row.spaceUpdatedAt !== space.updatedAt) {
    return { consented: false, reason: "page" };
  }
  return { consented: true };
}

// ---- backfill --------------------------------------------------------------

/**
 * Delegated consents given before auto_tools existed approved today's defaults.
 * Record that as concrete names: for every delegated viewer's row with no set,
 * store the Space's current delegable write tools. Needs the plugin registry
 * (effects), so it runs after plugins load. A Space with a tool that is not
 * usable at boot is skipped. Idempotent: the guarded UPDATE makes
 * concurrent workers write the same thing. Returns the number of rows filled.
 */
export async function backfillDelegatedConsents(): Promise<number> {
  const pending = await db.all<{ space_name: string; user_id: string }>(
    `SELECT c.space_name, c.user_id FROM space_consents c
     JOIN spaces s ON s.name = c.space_name
     WHERE c.auto_tools IS NULL AND s.access_mode = 'owner' AND c.user_id <> s.owner_id`
  );
  let filled = 0;
  for (const row of pending) {
    const space = await getSpace(row.space_name);
    // A tool missing now (a plugin that failed to load, a disabled integration)
    // cannot be classified, so the set recorded would be narrower than what the
    // viewer approved. Leave the row NULL: it reads as today's set later.
    if (!space || space.tools.some((name) => !usableTool(name))) continue;
    const result = await db.run(
      "UPDATE space_consents SET auto_tools = ? WHERE space_name = ? AND user_id = ? AND auto_tools IS NULL",
      [JSON.stringify(legacyApprovedSet(space)), row.space_name, row.user_id]
    );
    filled += result.changes;
  }
  return filled;
}
