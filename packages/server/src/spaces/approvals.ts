import { effectOf } from "@a-workbench/shared";
import { db } from "../db";
import { registry, type PluginTool } from "../plugins/registry";
import { isInternalIntegration } from "../plugins/internal-names";
import type { Space } from "./store";

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
