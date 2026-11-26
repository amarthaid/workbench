import { db } from "../db";
import { CAPABILITIES, capabilityDef, type Effect } from "./capabilities";

// General rules only (subject = ''). Subject-scoped rules and their precedence
// arrive with the first capability that needs them.
//
// No cache: a check always reads the table, so a revoke takes effect on the
// next call.
export async function can(userId: string, capability: string): Promise<boolean> {
  const def = capabilityDef(capability);
  if (!def) return false;
  const row = await db.get<{ effect: string }>(
    "SELECT effect FROM user_permissions WHERE user_id = ? AND capability = ? AND subject = ''",
    [userId, capability]
  );
  return (row?.effect ?? def.default) === "allow";
}

export async function setPermission(i: {
  userId: string;
  capability: string;
  effect: Effect;
  grantedBy: string;
}): Promise<void> {
  if (!capabilityDef(i.capability)) throw new Error(`unknown capability: ${i.capability}`);
  await db.run(
    `INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at)
     VALUES (?, ?, '', ?, ?, ?)
     ON CONFLICT (user_id, capability, subject) DO UPDATE SET
       effect = excluded.effect, granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    [i.userId, i.capability, i.effect, i.grantedBy, Math.floor(Date.now() / 1000)]
  );
}

export async function clearPermission(userId: string, capability: string): Promise<void> {
  await db.run(
    "DELETE FROM user_permissions WHERE user_id = ? AND capability = ? AND subject = ''",
    [userId, capability]
  );
}

export interface PermissionView {
  capability: string;
  label: string;
  description: string;
  default: Effect;
  effect: Effect;
  source: "default" | "rule";
  grantedBy: string | null;
  grantedAt: number | null;
}

export async function listPermissions(userId: string): Promise<PermissionView[]> {
  const rows = await db.all<{ capability: string; effect: string; granted_by: string; granted_at: number | string }>(
    "SELECT capability, effect, granted_by, granted_at FROM user_permissions WHERE user_id = ? AND subject = ''",
    [userId]
  );
  return Object.entries(CAPABILITIES).map(([key, def]) => {
    const r = rows.find((x) => x.capability === key);
    return {
      capability: key,
      label: def.label,
      description: def.description,
      default: def.default,
      effect: (r?.effect as Effect | undefined) ?? def.default,
      source: r ? "rule" : "default",
      grantedBy: r?.granted_by ?? null,
      grantedAt: r ? Number(r.granted_at) : null,
    };
  });
}
