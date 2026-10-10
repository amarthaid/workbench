// Which URLs an agent may point the shared browser at.
//
// Loopback is refused: chromium's remote-debugging HTTP endpoint listens there,
// and `/json/list` names every target (private auto-reconnect tabs included)
// while `/json/close/<id>` kills one. Other loopback services (the server's
// own admin and metrics) are no business of an agent's tab either. This is the
// check on URLs an agent *passes*, a fast friendly error; the network guard
// on every agent tab (agent-net-guard.ts) is the enforcement, and covers
// script navigations, redirects, popups and subresources, which no input
// check sees. Hostnames that merely resolve to loopback are not caught by
// this literal check; the network guard resolves them.

/**
 * A resolved or literal address (no brackets) in loopback or "this host":
 * 127.0.0.0/8, 0.0.0.0/8, ::1, ::, and their IPv4-mapped IPv6 forms.
 */
export function isLoopbackAddress(ip: string): boolean {
  const a = ip.toLowerCase();
  const v4 = /^(\d+)\.\d+\.\d+\.\d+$/.exec(a);
  if (v4) return v4[1] === "127" || v4[1] === "0";
  if (a === "::1" || a === "::" || a === "0:0:0:0:0:0:0:1" || a === "0:0:0:0:0:0:0:0") return true;
  const dotted = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) return isLoopbackAddress(dotted[1]);
  const hex = /^(?:0{0,4}:){0,5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) {
    const hi = parseInt(hex[1], 16) >> 8;
    return hi === 127 || hi === 0;
  }
  return false;
}

/** `hostname` as `URL.hostname` gives it: lowercased, IPv4 canonical, IPv6 bracketed. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // The URL parser already turned 2130706433, 0x7f.1 and 127.1 into dotted quads.
  if (h.startsWith("[") && h.endsWith("]")) return isLoopbackAddress(h.slice(1, -1));
  return isLoopbackAddress(h);
}

/** http(s) and not loopback. */
export function isAgentNavigableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return !isLoopbackHost(u.hostname);
}
