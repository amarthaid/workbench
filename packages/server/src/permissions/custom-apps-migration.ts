import { db } from "../db";

// Custom apps used to be gated by an instance policy (all, none, or an
// allowlist). They are now the per-user capability "custom_apps.create", which
// defaults to deny. This turns the old policy into allow rows once, so nobody
// who could add custom apps loses it on upgrade. Users created afterwards start
// denied. Nothing about an existing custom app is touched.

const POLICY_KEY = "custom_apps_policy";
const MARKER_KEY = "custom_apps_policy_migrated";
const CAPABILITY = "custom_apps.create";
const GRANTOR = "system";

/** The stored policy as the user ids it admits (null means everyone). A missing or unreadable row is the old default, "all". */
function admitted(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  try {
    const v = JSON.parse(raw) as { mode?: unknown; user_ids?: unknown } | null;
    if (v?.mode === "none") return [];
    if (v?.mode === "allowlist" && Array.isArray(v.user_ids)) {
      return v.user_ids.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // fall through to the default
  }
  return null;
}

/**
 * Run the migration. Returns how many users were granted (0 when it had
 * already run, another process ran it, or nobody qualified).
 *
 * The marker insert arbitrates: the marker and the rows are written in one
 * transaction, and only the process whose marker insert took effect writes
 * rows. A concurrent run waits on the marker's primary key, then inserts
 * nothing. Rows use ON CONFLICT DO NOTHING, so a rule an admin set earlier is
 * never overwritten.
 */
export async function migrateCustomAppsPolicy(): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const granted = await db.transaction(async (tx) => {
    const marker = await tx.run(
      `INSERT INTO instance_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO NOTHING`,
      [MARKER_KEY, String(now), now, GRANTOR]
    );
    if (marker.changes !== 1) return null;

    const row = await tx.get<{ value: string }>("SELECT value FROM instance_settings WHERE key = ?", [POLICY_KEY]);
    const list = admitted(row?.value);
    let ids: string[];
    if (list === null) {
      ids = (await tx.all<{ id: string }>("SELECT id FROM users")).map((r) => r.id);
    } else if (list.length === 0) {
      ids = [];
    } else {
      const unique = [...new Set(list)];
      ids = (
        await tx.all<{ id: string }>(`SELECT id FROM users WHERE id IN (${unique.map(() => "?").join(",")})`, unique)
      ).map((r) => r.id);
    }
    let n = 0;
    for (const id of ids) {
      const res = await tx.run(
        `INSERT INTO user_permissions (user_id, capability, subject, effect, granted_by, granted_at)
         VALUES (?, ?, '', 'allow', ?, ?) ON CONFLICT (user_id, capability, subject) DO NOTHING`,
        [id, CAPABILITY, GRANTOR, now]
      );
      n += res.changes;
    }
    return n;
  });
  if (granted === null) return 0;
  console.log(`[permissions] custom apps policy migrated: ${granted} user(s) allowed`);
  return granted;
}
