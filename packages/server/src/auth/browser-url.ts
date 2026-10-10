// Which URLs an agent may point the shared browser at.
//
// Loopback is refused: chromium's remote-debugging HTTP endpoint listens there,
// and `/json/list` names every target (private auto-reconnect tabs included)
// while `/json/close/<id>` kills one. Other loopback services (the server's
// own admin and metrics) are no business of an agent's tab either. This is the
// check on URLs an agent *passes*; the browser-level block on the debug port
// (blockDebugEndpoint in browser-session.ts) covers script navigations,
// which no input check sees. Hostnames that merely resolve to loopback are a
// DNS-level concern this literal check does not cover; the port block does.

/** `hostname` as `URL.hostname` gives it: lowercased, IPv4 canonical, IPv6 bracketed. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // The URL parser already turned 2130706433, 0x7f.1 and 127.1 into dotted quads.
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^0\.\d+\.\d+\.\d+$/.test(h)) return true; // 0.0.0.0 reaches this host
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1);
    if (v6 === "::1" || v6 === "::") return true;
    // IPv4-mapped loopback / unspecified, as the URL parser prints it.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
    if (mapped) {
      const hi = parseInt(mapped[1], 16) >> 8;
      return hi === 127 || hi === 0;
    }
  }
  return false;
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
