// Network guard for agent-visible browser tabs.
//
// Every user's chromium listens for remote debugging on its own
// 127.0.0.1:<port>. From an agent tab, `GET /json/list` on ANY of those ports
// names that chromium's targets (another user's private recipe tab included)
// and `GET /json/close/<id>` kills one; a GET with side effects needs no
// readable response, so CORS does not help. A URL check on browser_navigate
// cannot stop script navigations, window.open, links, redirects, meta
// refresh, forms or subresources. So every request an agent tab, or anything
// it opens (popups, out-of-process iframes, workers), makes is paused by
// chromium (Fetch domain, all URLs, all resource types) and released here
// only when its host is not loopback / unspecified / the workbench server's
// own internal origin. Each redirect hop is paused as its own request, so a
// public page that 302s to loopback is caught on the hop.
//
// Never installed on the private recipe tab: the server drives it, and
// recipes are trusted manifest data.
//
// Residual: a hostname is resolved here and again by chromium. A DNS
// rebinding answer (public here, loopback a moment later in chromium) can
// slip through between the two lookups.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config";
import { isLoopbackAddress, isLoopbackHost } from "./browser-url";

export interface CdpLike {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(method: string, fn: (p: Record<string, unknown>, sessionId?: string) => void): () => void;
}

const DNS_CACHE_MS = 60_000;
const DNS_TIMEOUT_MS = 2_000;
const DNS_CACHE_MAX = 2_000;

/** Test seams. */
export const __netGuard = {
  async resolve(host: string): Promise<string[]> {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.map((a) => a.address);
  },
  cache: new Map<string, { at: number; blocked: boolean }>(),
};

/** The test-only opt-out. Never honoured in production. */
function loopbackAllowed(): boolean {
  return config.BROWSER_ALLOW_LOOPBACK && process.env.NODE_ENV !== "production";
}

/** Hostnames that are the workbench server itself, on any port. */
function internalHosts(): string[] {
  const out: string[] = [];
  if (config.INTERNAL_MCP_URL) {
    try { out.push(new URL(config.INTERNAL_MCP_URL).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  return out;
}

async function resolvesToLoopback(host: string): Promise<boolean> {
  const now = Date.now();
  const hit = __netGuard.cache.get(host);
  if (hit && now - hit.at < DNS_CACHE_MS) return hit.blocked;
  let blocked = false;
  try {
    const addrs = await Promise.race([
      __netGuard.resolve(host),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), DNS_TIMEOUT_MS)),
    ]);
    blocked = addrs.some(isLoopbackAddress);
  } catch {
    // Unresolvable here: chromium cannot reach it either. A timeout is not
    // cached, so the next request asks again.
    return false;
  }
  if (__netGuard.cache.size >= DNS_CACHE_MAX) __netGuard.cache.clear();
  __netGuard.cache.set(host, { at: now, blocked });
  return blocked;
}

/** True when an agent tab must not send this request. Fails closed on a URL it cannot parse. */
export async function isBlockedAgentRequest(rawUrl: unknown): Promise<boolean> {
  if (typeof rawUrl !== "string") return true;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }
  // data:, blob:, about: never reach the network.
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  const bare = host.startsWith("[") ? host.slice(1, -1) : host.replace(/\.$/, "");
  if (internalHosts().includes(host) || internalHosts().includes(bare)) return true;
  if (loopbackAllowed()) return false;
  if (isLoopbackHost(host)) return true;
  if (isIP(bare)) return false; // a literal that is not loopback
  return resolvesToLoopback(bare);
}

export interface GuardHooks {
  /** True for a target the server opened privately (an auto-reconnect recipe tab). */
  isPrivate(targetId: string): boolean;
  /** A page opened by a private tab (an SSO popup): private too, hidden from agents. */
  markPrivate(targetId: string): void;
}

export interface BrowserNetGuard {
  /** Stop intercepting a target now known to be private (the attach may have come first). */
  release(targetId: string): Promise<void>;
}

/**
 * Install the guard on the BROWSER-target client. Every target chromium
 * creates from now on (agent tabs, popups from window.open / target=_blank,
 * workers) is auto-attached paused (`waitForDebuggerOnStart`), given Fetch
 * interception for all URLs, and only then resumed, so nothing it loads
 * escapes the check. Each guarded page also auto-attaches to its own
 * out-of-process iframes the same way. Targets that already exist (the tab
 * chromium opened at spawn) are attached as well; one already showing a
 * blocked URL is sent to about:blank.
 *
 * Private recipe tabs, and pages they open, are released without
 * interception; a request from one that was attached before it was known to
 * be private is continued unchecked.
 */
export async function installBrowserNetGuard(cdp: CdpLike, hooks: GuardHooks): Promise<BrowserNetGuard> {
  const sessions = new Map<string, { targetId: string; private: boolean }>();
  const bySession = (sid?: string) => (sid ? sessions.get(sid) : undefined);

  cdp.on("Fetch.requestPaused", (p, sid) => {
    void (async () => {
      const requestId = p.requestId;
      const s = bySession(sid);
      const trusted = !!s && (s.private || hooks.isPrivate(s.targetId));
      const url = (p.request as { url?: unknown } | undefined)?.url;
      const blocked = !trusted && (await isBlockedAgentRequest(url).catch(() => true));
      await cdp
        .send(blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
          blocked ? { requestId, errorReason: "BlockedByClient" } : { requestId }, sid)
        .catch(() => {});
    })();
  });

  cdp.on("Target.attachedToTarget", (p, parentSid) => {
    void (async () => {
      const child = p.sessionId;
      const info = (p.targetInfo ?? {}) as { targetId?: unknown; type?: unknown; openerId?: unknown; url?: unknown };
      if (typeof child !== "string" || typeof info.targetId !== "string") return;
      const targetId = info.targetId;
      const opener = typeof info.openerId === "string" ? info.openerId : undefined;
      const isPrivate =
        !!bySession(parentSid)?.private || hooks.isPrivate(targetId) || (!!opener && hooks.isPrivate(opener));
      if (isPrivate && info.type === "page" && opener) hooks.markPrivate(targetId);
      sessions.set(child, { targetId, private: isPrivate });
      if (!isPrivate) {
        try {
          await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child);
          await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
        } catch {
          // A page or frame that cannot be guarded is closed, not resumed.
          if (info.type === "page" || info.type === "iframe") {
            await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
            return;
          }
        }
        if (!p.waitingForDebugger && typeof info.url === "string" && /^(https?|wss?):/i.test(info.url)
          && (await isBlockedAgentRequest(info.url))) {
          await cdp.send("Page.navigate", { url: "about:blank" }, child).catch(() => {});
        }
      }
      // Paused at creation: it has made no request before this point.
      if (p.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    })();
  });

  cdp.on("Target.detachedFromTarget", (p) => {
    if (typeof p.sessionId === "string") sessions.delete(p.sessionId);
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  return {
    async release(targetId: string) {
      for (const [sid, s] of sessions) {
        if (s.targetId !== targetId) continue;
        s.private = true;
        await cdp.send("Fetch.disable", {}, sid).catch(() => {});
      }
    },
  };
}
