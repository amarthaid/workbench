import { isPrivateHost } from "../auth/plugin-oauth";

/**
 * Connector base URLs are user-supplied and the server fetches them (metadata
 * discovery, client registration, token exchange, tool calls) — the SSRF
 * surface. Loopback is allowed so a local MCP server can be tested in dev;
 * everything else private (RFC1918, link-local incl. cloud metadata,
 * unique/local link IPv6) is blocked. Hostnames that resolve privately still
 * get through this literal check — that is a DNS-level concern out of scope
 * here, same as the existing plugin-instance allowlist.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const loopback =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "[::1]" ||
    /^127\./.test(h);
  if (loopback) return false;
  return isPrivateHost(h);
}

/** Validate a connector base URL: http(s) only, no creds, host not blocked. */
export function normalizeBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (isBlockedHost(u.hostname)) return null;
  // Keep path (the MCP endpoint) but drop query/fragment.
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}
