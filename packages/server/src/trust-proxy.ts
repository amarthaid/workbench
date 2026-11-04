// Which address a request really came from.
//
// TRUST_PROXY (config.ts) becomes Fastify's `trustProxy`, which turns
// X-Forwarded-For into `request.ip` for the hops it trusts. CLIENT_IP_HEADER
// names a single-value header a CDN sets instead (Cloudflare's
// CF-Connecting-IP, Akamai's True-Client-IP, nginx's X-Real-IP). Any client
// can send such a header, so it is believed only when the connection itself
// comes from a proxy TRUST_PROXY trusts, and only when it holds a valid IP;
// otherwise `request.ip` stands.

import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";
import { config } from "./config";

type TrustProxy = boolean | number | string[] | undefined;

/** TRUST_PROXY as Fastify's `trustProxy`; a hop count becomes "trust the first N hops". */
export function trustProxyOption(
  t: TrustProxy
): { trustProxy?: boolean | string[] | ((addr: string, i: number) => boolean) } {
  if (t === undefined) return {};
  if (typeof t === "number") return { trustProxy: (_addr: string, i: number) => i < t };
  return { trustProxy: t };
}

// proxy-addr's named ranges, which Fastify accepts in a TRUST_PROXY list.
const NAMED: Record<string, string[]> = {
  loopback: ["127.0.0.0/8", "::1/128"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  uniquelocal: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
};

function unmap(addr: string): string {
  return addr.startsWith("::ffff:") && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
}

/** Does TRUST_PROXY trust the directly connected peer `addr`? */
export function trustsPeer(t: TrustProxy, addr: string | undefined): boolean {
  if (!addr || t === undefined || t === false) return false;
  if (t === true) return true;
  if (typeof t === "number") return t >= 1;
  const peer = unmap(addr);
  const family = isIP(peer) === 6 ? "ipv6" : "ipv4";
  const list = new BlockList();
  for (const raw of t) {
    for (const entry of NAMED[raw.toLowerCase()] ?? [raw]) {
      const [ip, bits] = entry.split("/");
      const fam = isIP(ip);
      if (!fam) continue;
      const type = fam === 6 ? "ipv6" : "ipv4";
      if (bits === undefined) list.addAddress(ip, type);
      else list.addSubnet(ip, Number(bits), type);
    }
  }
  return list.check(peer, family);
}

/**
 * The client's address: CLIENT_IP_HEADER when set, sent by a trusted peer and
 * a valid IP; otherwise Fastify's `request.ip` (X-Forwarded-For per TRUST_PROXY).
 */
export function clientIp(
  request: Pick<FastifyRequest, "ip" | "headers"> & { socket?: { remoteAddress?: string } },
  opts: { trust: TrustProxy; header?: string } = { trust: config.TRUST_PROXY, header: config.CLIENT_IP_HEADER }
): string | undefined {
  if (opts.header && trustsPeer(opts.trust, request.socket?.remoteAddress)) {
    const raw = request.headers[opts.header];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value && isIP(unmap(value))) return unmap(value);
  }
  return request.ip || undefined;
}
