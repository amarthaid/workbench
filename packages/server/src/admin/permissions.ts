import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { capabilityDef, type Effect } from "../permissions/capabilities";
import { clearPermission, listPermissions, setPermission, type PermissionView } from "../permissions/store";
import type { AdminActor } from "../api/admin-scope";

type Target = { id: string; email: string | null };

type Failure =
  | { ok: false; status: 404; error: "user_not_found" }
  | { ok: false; status: 400; error: "unknown_capability" | "invalid_effect" };

export type PermissionsResult =
  | { ok: true; view: { permissions: PermissionView[]; delegatedSpaces: number } }
  | Failure;

export type PermissionActionResult = { ok: true } | Failure;

const NOT_FOUND: Failure = { ok: false, status: 404, error: "user_not_found" };
const UNKNOWN_CAPABILITY: Failure = { ok: false, status: 400, error: "unknown_capability" };

async function findUser(id: string): Promise<Target | undefined> {
  return db.get<Target>("SELECT id, email FROM users WHERE id = ?", [id]);
}

async function audit(
  actor: AdminActor,
  action: "ADMIN_PERMISSION_SET" | "ADMIN_PERMISSION_CLEAR",
  verb: "set" | "clear",
  target: Target,
  capability: string
): Promise<void> {
  await auditLogger.log({
    user_id: actor.userId,
    action,
    tool: `admin.permission.${verb} → ${target.email ?? target.id} ${capability}`,
    success: true,
  });
}

export async function getUserPermissions(id: string): Promise<PermissionsResult> {
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  // Spaces this user currently shares with delegated access. The count comes
  // from spaces.access_mode, which is added with that column.
  const delegatedSpaces = 0;
  return { ok: true, view: { permissions: await listPermissions(target.id), delegatedSpaces } };
}

// The admin choice is the opposite of the default, or Default (DELETE). A rule
// equal to the default would change nothing, so only the opposite effect is
// accepted: "allow" for a default-deny capability, "deny" for a default-allow one.
export async function grantPermission(
  actor: AdminActor,
  id: string,
  capability: string,
  body: unknown
): Promise<PermissionActionResult> {
  const def = capabilityDef(capability);
  if (!def) return UNKNOWN_CAPABILITY;
  const accepted: Effect = def.default === "allow" ? "deny" : "allow";
  const effect = (body as { effect?: unknown } | null | undefined)?.effect;
  if (effect !== accepted) return { ok: false, status: 400, error: "invalid_effect" };
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  await setPermission({ userId: target.id, capability, effect: accepted, grantedBy: actor.userId });
  await audit(actor, "ADMIN_PERMISSION_SET", "set", target, capability);
  return { ok: true };
}

export async function resetPermission(
  actor: AdminActor,
  id: string,
  capability: string
): Promise<PermissionActionResult> {
  if (!capabilityDef(capability)) return UNKNOWN_CAPABILITY;
  const target = await findUser(id);
  if (!target) return NOT_FOUND;
  // Already at the default: nothing changed, so nothing to audit.
  if (await clearPermission(target.id, capability)) {
    await audit(actor, "ADMIN_PERMISSION_CLEAR", "clear", target, capability);
  }
  return { ok: true };
}
