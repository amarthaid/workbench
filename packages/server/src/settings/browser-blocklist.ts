// Admin-managed domain blocklist for agent browser tabs.
//
// A plain entry blocks the domain itself and every subdomain: `example.com`
// blocks `example.com`, `www.example.com` and `a.b.example.com`, never
// `notexample.com`. A wildcard entry blocks subdomains only: `*.example.com`
// blocks `www.example.com` and `a.b.example.com` but leaves `example.com`
// reachable. `*.` is only allowed as the whole first label. An IP literal
// entry blocks that literal only. Matching is
// on the hostname the request names, not on what it resolves to, so a site
// reached by a different name (another domain, a bare IP) is not covered.

import { domainToASCII } from "node:url";
import { isIP } from "node:net";

export const MAX_BLOCKED_DOMAINS = 1000;

/**
 * Canonical form of an operator-typed entry, or null when it is not a
 * hostname. Accepts a bare host, a leading `*.` (kept: it means subdomains
 * only), a trailing dot, an IDN, and a pasted URL (only its host is kept).
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
  const wildcard = s.startsWith("*.");
  if (wildcard) s = s.slice(2);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (isIP(s)) return wildcard ? null : s; // an address has no subdomains
  s = s.replace(/\.+$/, "");
  const ascii = domainToASCII(s);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null; // a single label would match a whole TLD
  if (!labels.every((l) => /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return null;
  return wildcard ? `*.${ascii}` : ascii;
}

function canonicalHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.replace(/\.+$/, "");
}

/**
 * How specifically `entries` match `host`: the number of labels in the
 * longest matching entry (an IP literal counts as fully specific), or -1 when
 * none matches. A plain entry matches the domain and its subdomains; a `*.`
 * entry matches subdomains only, and counts the labels after `*.`.
 */
export function matchSpecificity(host: string, entries: readonly string[]): number {
  if (!entries.length) return -1;
  const h = canonicalHost(host);
  if (isIP(h)) return entries.includes(h) ? Number.MAX_SAFE_INTEGER : -1;
  let best = -1;
  for (const entry of entries) {
    const wildcard = entry.startsWith("*.");
    const d = wildcard ? entry.slice(2) : entry;
    const hit =
      (!wildcard && h === d) || (h.length > d.length && h.endsWith(d) && h[h.length - d.length - 1] === ".");
    if (hit) best = Math.max(best, d.split(".").length);
  }
  return best;
}

/**
 * True when `host` (a URL hostname) is blocked: equal to a plain entry, or a
 * subdomain of any entry (plain or `*.`).
 */
export function hostMatchesBlocklist(host: string, blocked: readonly string[]): boolean {
  return matchSpecificity(host, blocked) >= 0;
}

/**
 * The blocklist with allow exceptions. A host is blocked when a block entry
 * matches it and no allow entry matches it at least as specifically: the
 * more specific entry wins, and an allow entry wins a tie. So with
 * `block *.prod.example.com` and `allow x.prod.example.com`, `x.prod…` and its
 * subdomains load and every other `*.prod…` host is blocked; adding
 * `block bad.x.prod.example.com` blocks that one host again. An allow entry
 * on its own blocks nothing and unblocks nothing else: it only carves
 * exceptions out of block entries. It never lifts the loopback / internal-host
 * guard, which is checked separately.
 */
export function isHostBlockedBy(host: string, blocked: readonly string[], allowed: readonly string[]): boolean {
  const b = matchSpecificity(host, blocked);
  if (b < 0) return false;
  return matchSpecificity(host, allowed) < b;
}
