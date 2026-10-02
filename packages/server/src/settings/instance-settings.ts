import { config } from "../config";
import { db } from "../db";

export type CustomAppsMode = "all" | "none" | "allowlist";

export interface CustomAppsPolicy {
  mode: CustomAppsMode;
  user_ids: string[];
}

export interface InstanceSettings {
  disabled_integrations: string[];
  custom_apps_policy: CustomAppsPolicy;
}

const DEFAULTS: InstanceSettings = {
  disabled_integrations: [],
  custom_apps_policy: { mode: "all", user_ids: [] },
};

// The registry and the request path read these synchronously, so they read a
// snapshot rather than the database. It is replaced whole, never mutated.
let snapshot: InstanceSettings = DEFAULTS;

export function getSettings(): InstanceSettings {
  return snapshot;
}

export function isIntegrationDisabled(name: string): boolean {
  return snapshot.disabled_integrations.includes(name);
}

export function customAppsAllowedFor(userId: string): boolean {
  const p = snapshot.custom_apps_policy;
  if (p.mode === "all") return true;
  if (p.mode === "none") return false;
  return p.user_ids.includes(userId);
}

// A stored value is operator-editable data, so parse it tolerantly: a corrupt
// row falls back to the default for that key and never takes the instance down
// or quietly disables anything.
function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseDisabled(raw: string | undefined): string[] {
  const v = parseJson(raw);
  return Array.isArray(v) ? stringList(v) : [];
}

function parsePolicy(raw: string | undefined): CustomAppsPolicy {
  const v = parseJson(raw) as { mode?: unknown; user_ids?: unknown } | undefined;
  if (!v || typeof v !== "object") return DEFAULTS.custom_apps_policy;
  const mode = v.mode;
  if (mode !== "all" && mode !== "none" && mode !== "allowlist") return DEFAULTS.custom_apps_policy;
  if (!Array.isArray(v.user_ids)) return DEFAULTS.custom_apps_policy;
  return { mode, user_ids: stringList(v.user_ids) };
}

export async function loadSettings(): Promise<void> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM instance_settings");
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  snapshot = {
    disabled_integrations: parseDisabled(byKey.get("disabled_integrations")),
    custom_apps_policy: parsePolicy(byKey.get("custom_apps_policy")),
  };
}

export async function saveSetting(
  key: "disabled_integrations" | "custom_apps_policy",
  value: unknown,
  updatedBy: string
): Promise<void> {
  await db.run(
    `INSERT INTO instance_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), Math.floor(Date.now() / 1000), updatedBy]
  );
  await loadSettings();
}

let timer: NodeJS.Timeout | null = null;

export function startSettingsPoll(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Keep the last good snapshot if the database hiccups.
    loadSettings().catch(() => {});
  }, config.INSTANCE_SETTINGS_POLL_SECONDS * 1000);
  timer.unref();
}

export function stopSettingsPoll(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test seam: forget everything loaded so far. */
export function resetSettingsForTest(): void {
  snapshot = DEFAULTS;
}
