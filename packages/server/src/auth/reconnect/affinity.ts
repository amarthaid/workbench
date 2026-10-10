import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../../config";

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
