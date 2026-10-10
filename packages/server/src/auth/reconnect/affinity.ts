import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config";
import { registry } from "../../plugins/registry";
import { touchesBrowser, FORWARD_TIMEOUT_MS, RECIPE_FORWARD_TIMEOUT_MS } from "../affinity-forward";

// A user's chromium is process-local (docs/findings/2026-09-10-browser-session-pod-affinity.md).
// A reconnect may only drive it from the process that owns it: the request
// reached us through the affinity hop (verified X-Browser-Session), or there
// is no cluster to be wrong about.
const owner = new AsyncLocalStorage<true>();

export function runWithBrowserAffinity<T>(fn: () => T): T {
  return owner.run(true, fn);
}

export function mayOwnBrowser(): boolean {
  return !config.INTERNAL_MCP_URL || owner.getStore() === true;
}

export function hasRecipe(integration: string): boolean {
  const auth = registry.getIntegration(integration)?.auth;
  return auth?.type === "cookie" && !!auth.reconnect;
}

/**
 * True when this call must run on the replica that owns the user's chromium:
 * a browser_* tool, or a tool of a cookie integration that can auto-reconnect
 * (its recipe drives that chromium).
 */
export function needsBrowserAffinity(executions: unknown, directTool?: unknown): boolean {
  return touchesBrowser(executions, directTool) || touchesRecipe(executions, directTool);
}

/** Forward budget: long enough to cover a recipe run when the call may start one. */
export function affinityTimeoutMs(executions: unknown, directTool?: unknown): number {
  return touchesRecipe(executions, directTool) ? RECIPE_FORWARD_TIMEOUT_MS : FORWARD_TIMEOUT_MS;
}

/** True when the call names a tool of an integration with a reconnect recipe. */
export function touchesRecipe(executions: unknown, directTool?: unknown): boolean {
  const names: unknown[] = [directTool];
  if (Array.isArray(executions)) {
    for (const e of executions) if (e && typeof e === "object") names.push((e as { tool?: unknown }).tool);
  }
  return names.some((n) => {
    if (typeof n !== "string") return false;
    const integ = registry.getTool(n)?.integration;
    return !!integ && hasRecipe(integ);
  });
}
