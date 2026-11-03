// Admin-managed domain blocklist for agent browser tabs.
//
// An entry blocks the domain itself and every subdomain: `example.com` blocks
// `example.com`, `www.example.com` and `a.b.example.com`, never
// `notexample.com`. An IP literal entry blocks that literal only. Matching is
// on the hostname the request names, not on what it resolves to, so a site
// reached by a different name (another domain, a bare IP) is not covered.

import { domainToASCII } from "node:url";
import { isIP } from "node:net";

export const MAX_BLOCKED_DOMAINS = 1000;

/**
 * Canonical form of an operator-typed entry, or null when it is not a
 * hostname. Accepts a bare host, a `*.` prefix, a trailing dot, an IDN, and a
 * pasted URL (only its host is kept).
 */
export function normaliseBlockedDomain(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  if (s.startsWith("*.")) s = s.slice(2);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (isIP(s)) return s;
  s = s.replace(/\.+$/, "");
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null; // a single label would match a whole TLD
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return ascii;
}

/** True when `host` (a URL hostname) is a blocked entry or a subdomain of one. */
export function hostMatchesBlocklist(host: string, blocked: readonly string[]): boolean {
  if (!blocked.length) return false;
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, "");
  if (isIP(h)) return blocked.includes(h);
  for (const d of blocked) {
    if (h === d || (h.length > d.length && h.endsWith(d) && h[h.length - d.length - 1] === ".")) return true;
  }
  return false;
}
