import { db } from "../db";
import { auditLogger } from "../audit/logger";
import { registry } from "../plugins/registry";
import {
  getSettings,
  isIntegrationDisabled,
  loadSettings,
  saveSetting,
  type CustomAppsPolicy,
} from "../settings/instance-settings";
import { MAX_BLOCKED_DOMAINS, normaliseBlockedDomain } from "../settings/browser-blocklist";
import type { AdminActor } from "../api/admin-scope";

export interface ConfigView {
  integrations: { name: string; display_name: string; enabled: boolean }[];
  custom_apps_policy: CustomAppsPolicy;
  browser_blocked_domains: string[];
  browser_allowed_domains: string[];
}

export type ConfigResult =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 404;
      error: "unknown_integration" | "invalid_body" | "invalid_policy" | "unknown_user" | "invalid_domains";
      invalid?: string[];
    };

const MAX_ALLOWLIST = 500;

export function getConfigView(): ConfigView {
  return {
    integrations: registry
      .listAllIntegrations()
      .map((i) => ({ name: i.name, display_name: i.displayName || i.name, enabled: !isIntegrationDisabled(i.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    custom_apps_policy: getSettings().custom_apps_policy,
    browser_blocked_domains: getSettings().browser_blocked_domains,
    browser_allowed_domains: getSettings().browser_allowed_domains,
  };
}

export async function setIntegrationEnabled(
  actor: AdminActor,
  name: string,
  body: unknown
): Promise<ConfigResult> {
  const enabled = (body as { enabled?: unknown } | null | undefined)?.enabled;
  if (typeof enabled !== "boolean") return { ok: false, status: 400, error: "invalid_body" };
  if (!registry.listAllIntegrations().some((i) => i.name === name)) {
    return { ok: false, status: 404, error: "unknown_integration" };
  }

  // This is a read-modify-write of one JSON list, and this process's snapshot can
  // be up to a poll interval stale. Re-read first, so a change another worker just
  // made is built on rather than overwritten. It narrows the race to milliseconds;
  // it does not remove it.
  await loadSettings();
  const disabled = new Set(getSettings().disabled_integrations);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  await saveSetting("disabled_integrations", [...disabled].sort(), actor.userId);

  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_INTEGRATION_SET",
    tool: `admin.config.integration ${name}=${enabled ? "enabled" : "disabled"}`,
    success: true,
  });
  return { ok: true };
}

export async function setCustomAppsPolicy(actor: AdminActor, body: unknown): Promise<ConfigResult> {
  const b = body as { mode?: unknown; user_ids?: unknown } | null | undefined;
  const mode = b?.mode;
  if (mode !== "all" && mode !== "none" && mode !== "allowlist") {
    return { ok: false, status: 400, error: "invalid_policy" };
  }

  let userIds: string[] = [];
  if (mode === "allowlist") {
    const ids = b?.user_ids ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_ALLOWLIST || !ids.every((x) => typeof x === "string")) {
      return { ok: false, status: 400, error: "invalid_policy" };
    }
    userIds = [...new Set(ids as string[])];
    if (userIds.length > 0) {
      const found = await db.all<{ id: string }>(
        `SELECT id FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
        userIds
      );
      if (found.length !== userIds.length) return { ok: false, status: 400, error: "unknown_user" };
    }
  }

  await saveSetting("custom_apps_policy", { mode, user_ids: userIds }, actor.userId);
  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_CUSTOM_APPS_POLICY",
    tool: `admin.config.custom-apps=${mode}`,
    success: true,
  });
  return { ok: true };
}

function normaliseList(v: unknown): { list: string[]; invalid: string[] } | null {
  if (!Array.isArray(v) || v.length > MAX_BLOCKED_DOMAINS || !v.every((d) => typeof d === "string")) return null;
  const out = new Set<string>();
  const invalid: string[] = [];
  for (const raw of v as string[]) {
    if (!raw.trim()) continue;
    const n = normaliseBlockedDomain(raw);
    if (n) out.add(n);
    else invalid.push(raw.slice(0, 100));
  }
  return { list: [...out].sort(), invalid };
}

/**
 * Replace the agent browser's domain blocklist (`domains`) and, when sent, its
 * allow exceptions (`allowed`; omitted = left as stored). Each list is sent
 * whole, so there is no read-modify-write to race. Entries are normalised
 * (lowercase, punycode, trailing dot dropped, a pasted URL reduced to its host;
 * a leading `*.` is kept); any entry that is not a hostname or IP rejects the
 * whole request and is named back, so a typo is never silently dropped.
 */
export async function setBrowserBlockedDomains(actor: AdminActor, body: unknown): Promise<ConfigResult> {
  const b = body as { domains?: unknown; allowed?: unknown } | null | undefined;
  const blocked = normaliseList(b?.domains);
  const allowed = b?.allowed === undefined ? undefined : normaliseList(b.allowed);
  if (!blocked || allowed === null) return { ok: false, status: 400, error: "invalid_body" };
  const invalid = [...blocked.invalid, ...(allowed?.invalid ?? [])];
  if (invalid.length) return { ok: false, status: 400, error: "invalid_domains", invalid: invalid.slice(0, 20) };

  await saveSetting("browser_blocked_domains", blocked.list, actor.userId);
  if (allowed) await saveSetting("browser_allowed_domains", allowed.list, actor.userId);
  const allowCount = allowed ? allowed.list.length : getSettings().browser_allowed_domains.length;
  await auditLogger.log({
    user_id: actor.userId,
    action: "ADMIN_BROWSER_BLOCKLIST",
    tool: `admin.config.browser-blocklist count=${blocked.list.length} allowed=${allowCount}`,
    success: true,
  });
  return { ok: true };
}
