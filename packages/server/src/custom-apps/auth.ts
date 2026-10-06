import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isHeadersApp, type CustomApp } from "./store";
import { headersToRecord } from "./headers";
import { ensureCustomAppToken } from "./oauth";

/** Request headers that authenticate workbench to the app's server. */
export async function resolveAuthHeaders(userId: string, app: CustomApp): Promise<Record<string, string>> {
  if (isHeadersApp(app)) {
    // Empty means corrupt/undecryptable (see store.toCustomApp) — fail loudly
    // rather than call the server unauthenticated.
    if (!app.headers || app.headers.length === 0) throw new Error("App headers are missing or unreadable — re-enter them");
    return headersToRecord(app.headers);
  }
  return { Authorization: `Bearer ${await ensureCustomAppToken(userId, app)}` };
}

/** A user-facing hint for an upstream 401/403 on a headers app; null otherwise. */
export function upstreamAuthHint(app: CustomApp, e: unknown): string | null {
  if (!isHeadersApp(app)) return null;
  const code = (e as { code?: unknown } | null)?.code;
  if (e instanceof StreamableHTTPError || typeof code === "number") {
    if (code === 401 || code === 403) {
      return `Server rejected the app's headers (HTTP ${code}) — check the app's headers`;
    }
  }
  return null;
}

/**
 * Strip every stored header value from text that may have echoed them (an
 * upstream error body, an SDK message). Longest values first so a value that
 * contains another is removed whole.
 */
export function redactHeaderValues(app: CustomApp, text: string): string {
  if (!isHeadersApp(app)) return text;
  const values = [...new Set((app.headers ?? []).map((h) => h.value).filter((v) => v.length >= 1))]
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of values) out = out.split(v).join("[redacted]");
  return out;
}
