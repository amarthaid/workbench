import { lookup } from "node:dns/promises";
import { isPrivateHost } from "../auth/plugin-oauth";

/**
 * CustomApp base URLs AND every endpoint the remote metadata advertises are
 * user/attacker-influenced and fetched server-side (metadata discovery, client
 * registration, token exchange, tool calls) — the SSRF surface. Everything
 * private (RFC1918, link-local incl. cloud metadata, unique/local IPv6) is
 * blocked. Loopback is allowed ONLY in development so a local MCP server can
 * be tested — in production any user could otherwise reach the server's own
 * loopback (CDP, admin, metrics). Hostnames that resolve privately still get
 * through this literal check — a DNS-level concern out of scope here, same as
 * the existing plugin-instance allowlist.
 */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  const loopback =
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h === "::1" ||
    h === "[::1]" ||
    /^127\./.test(h);
  // Allow loopback ONLY when NODE_ENV is explicitly "development" — a prod
  // deploy that forgets to set NODE_ENV must not silently open loopback.
  if (loopback) return process.env.NODE_ENV !== "development";
  return isPrivateHost(h);
}

/** Validate a app base URL: http(s) only, no creds, host not blocked. */
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

/**
 * Assert a URL (discovered endpoint, redirect target) is safe to fetch: http(s)
 * only, no embedded creds, host not blocked. Throws — callers surface the error.
 */
export function assertSafeUrl(raw: string, label: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label}: invalid URL ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${label}: unsupported protocol ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error(`${label}: URL must not contain credentials`);
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error(`${label}: host ${u.hostname} is not allowed`);
  }
  return u.toString();
}

/**
 * fetch that refuses to follow redirects to a blocked host. `redirect:
 * "manual"` stops the built-in follow; a 3xx is then treated as a hard error
 * (OAuth/registration endpoints should not redirect), so a public endpoint can
 * never bounce the request to an internal host.
 */
/** DNS-resolved address → blocked?, same loopback-in-dev rule as isBlockedHost. */
function isBlockedIp(addr: string): boolean {
  // lookup() returns bracketless IPv6; isBlockedHost expects hostname form.
  return isBlockedHost(addr.includes(":") ? `[${addr}]` : addr);
}

export async function safeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const u = new URL(url);
  const hostname = u.hostname.replace(/^\[|\]$/g, "");
  const originalHost = u.host;

  // The literal host check can't see a DNS name that RESOLVES privately
  // (169.254.169.254.nip.io, an internal name) — resolve and check the IPs.
  let resolved: { address: string }[] | null = null;
  try {
    resolved = await lookup(hostname, { all: true });
  } catch {
    resolved = null; // DNS failure — let the fetch below surface the real error
  }
  if (resolved && resolved.some((a) => isBlockedIp(a.address))) {
    throw new Error(`Refusing to fetch ${hostname}: resolves to a private IP`);
  }

  // Pin plain-HTTP fetches to the resolved address so a second DNS lookup can't
  // rebind to a private IP (TOCTOU). HTTPS keeps the hostname — the cert/SNI
  // are bound to it, so connecting to the raw IP would fail verification.
  let target: string | URL = url;
  let headers: RequestInit["headers"] = init?.headers;
  if (u.protocol === "http:" && resolved && resolved.length) {
    target = new URL(url);
    target.hostname = resolved[0].address;
    const h = new Headers(init?.headers);
    h.set("Host", originalHost);
    headers = h;
  }

  const res = await fetch(target, { ...init, headers, redirect: "manual" });
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    throw new Error(`Refusing to follow redirect from ${String(url)} to ${res.headers.get("location")}`);
  }
  return res;
}
