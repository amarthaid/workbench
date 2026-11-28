import type { IntegrationSummary } from "./api";

// The apps every workbench ships with. They need no sign-in and are always
// there, so they never lead a list. Mirrors INTERNAL_PLUGIN_NAMES on the server.
export const BUILT_IN_APPS: readonly string[] = ["browser", "jots", "files", "vault", "spaces"];

/**
 * Display tier, lowest first: connectable apps (Gmail, Slack, ...), then the
 * person's own custom apps, then the built-in tools.
 */
export function appTier(app: Pick<IntegrationSummary, "name" | "custom">): 0 | 1 | 2 {
  if (BUILT_IN_APPS.includes(app.name)) return 2;
  return app.custom ? 1 : 0;
}

/** Tier first, then name. Stable and independent of connection state. */
export function compareApps(
  a: Pick<IntegrationSummary, "name" | "custom" | "displayName">,
  b: Pick<IntegrationSummary, "name" | "custom" | "displayName">
): number {
  const t = appTier(a) - appTier(b);
  if (t !== 0) return t;
  return (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name);
}
