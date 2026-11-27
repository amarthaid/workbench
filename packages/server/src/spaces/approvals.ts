import { db } from "../db";

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
