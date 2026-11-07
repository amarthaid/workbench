// Integration names of the internal plugins (server source, auth "none"). A
// disk plugin may not take one of these names, and a Space may not declare a
// tool from one of them. Kept apart from loader.ts so modules that need the
// list do not import every internal plugin.
export const INTERNAL_PLUGIN_NAMES = ["browser", "jots", "files", "vault", "spaces"] as const;

export function isInternalIntegration(name: string): boolean {
  return (INTERNAL_PLUGIN_NAMES as readonly string[]).includes(name);
}
