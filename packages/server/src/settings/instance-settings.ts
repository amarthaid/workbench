import { config } from "../config";
import { db } from "../db";
import { isHostBlockedBy, normaliseBlockedDomain } from "./browser-blocklist";

export interface InstanceSettings {
  disabled_integrations: string[];
  /** Hosts agent browser tabs may not load (each also blocks its subdomains). */
  browser_blocked_domains: string[];
  /** Exceptions to the blocklist: the more specific entry wins, allow wins a tie. */
  browser_allowed_domains: string[];
}

const DEFAULTS: InstanceSettings = {
  disabled_integrations: [],
  browser_blocked_domains: [],
  browser_allowed_domains: [],
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

/** True when an agent browser tab must not load a URL on this host. */
export function isBrowserHostBlocked(host: string): boolean {
  return isHostBlockedBy(host, snapshot.browser_blocked_domains, snapshot.browser_allowed_domains);
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

function parseBlockedDomains(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const d of stringList(parseJson(raw))) {
    const n = normaliseBlockedDomain(d);
    if (n) out.add(n);
  }
  return [...out];
}

export async function loadSettings(): Promise<void> {
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM instance_settings");
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  snapshot = {
    disabled_integrations: parseDisabled(byKey.get("disabled_integrations")),
    browser_blocked_domains: parseBlockedDomains(byKey.get("browser_blocked_domains")),
    browser_allowed_domains: parseBlockedDomains(byKey.get("browser_allowed_domains")),
  };
}

export async function saveSetting(
  key: "disabled_integrations" | "browser_blocked_domains" | "browser_allowed_domains",
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

/** Test seam: replace parts of the snapshot without a database round trip. */
export function setSettingsForTest(patch: Partial<InstanceSettings>): void {
  snapshot = { ...snapshot, ...patch };
}
