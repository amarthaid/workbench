// Network guard for agent-visible browser tabs.
//
// Every user's chromium listens for remote debugging on its own
// 127.0.0.1:<port>. From an agent tab, `GET /json/list` on ANY of those ports
// names that chromium's targets (another user's private recipe tab included)
// and `GET /json/close/<id>` kills one; a GET with side effects needs no
// readable response, so CORS does not help. A URL check on browser_navigate
// cannot stop script navigations, window.open, links, redirects, meta
// refresh, forms or subresources. So every HTTP(S) request an agent tab, or anything
// it opens (popups, out-of-process iframes, workers), makes is paused by
// chromium (Fetch domain, all URLs, all resource types) and released here
// only when its host is not loopback / unspecified / the workbench server's
// own internal origin. Each redirect hop is paused as its own request, so a
// public page that 302s to loopback is caught on the hop. WebSocket handshakes
// are NOT paused by Fetch (see the finding doc); DevTools sockets are refused
// by origin instead (cdp-origin.ts).
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
import { effectivePort, isAllowedLoopbackPort, isInternalHost, isLoopbackAddress, isLoopbackHost } from "./browser-url";

export interface CdpLike {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(method: string, fn: (p: Record<string, unknown>, sessionId?: string) => void): () => void;
}

const DNS_CACHE_MS = 60_000;
const DNS_NEGATIVE_CACHE_MS = 10_000;
const DNS_CACHE_MAX = 2_000;

type Resolved = "loopback" | "public" | "fail";

/** Test seams. */
export const __netGuard = {
  async resolve(host: string): Promise<string[]> {
    const addrs = await lookup(host, { all: true, verbatim: true });
    return addrs.map((a) => a.address);
  },
  cache: new Map<string, { at: number; ttl: number; result: Resolved }>(),
  /** Bound on queueing + lookup for one hostname; past it the request is failed. */
  timeoutMs: 2_000,
  maxConcurrent: 8,
};

/** The test-only opt-out. Never honoured in production. */
function loopbackAllowed(): boolean {
  return config.BROWSER_ALLOW_LOOPBACK && process.env.NODE_ENV !== "production";
}

// At most __netGuard.maxConcurrent lookups at once; one in flight per host.
let active = 0;
const waiting: Array<() => void> = [];
const inFlight = new Map<string, Promise<Resolved>>();

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= __netGuard.maxConcurrent) await new Promise<void>((r) => waiting.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

async function lookupOnce(host: string): Promise<Resolved> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addrs = await Promise.race([
      withSlot(() => __netGuard.resolve(host)),
      new Promise<string[]>((_, rej) => { timer = setTimeout(() => rej(new Error("dns timeout")), __netGuard.timeoutMs); }),
    ]);
    if (!addrs.length) return "fail";
    return addrs.some(isLoopbackAddress) ? "loopback" : "public";
  } catch {
    return "fail"; // NXDOMAIN, SERVFAIL, timeout: fail closed
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHost(host: string): Promise<Resolved> {
  const now = Date.now();
  const hit = __netGuard.cache.get(host);
  if (hit && now - hit.at < hit.ttl) return hit.result;
  let p = inFlight.get(host);
  if (!p) {
    p = lookupOnce(host).then((result) => {
      if (__netGuard.cache.size >= DNS_CACHE_MAX) __netGuard.cache.clear();
      __netGuard.cache.set(host, { at: Date.now(), ttl: result === "public" ? DNS_CACHE_MS : DNS_NEGATIVE_CACHE_MS, result });
      return result;
    }).finally(() => inFlight.delete(host));
    inFlight.set(host, p);
  }
  return p;
}

/**
 * True when an agent target must not send this request. Fails closed: an
 * unparsable URL, an unknown scheme, and a hostname that does not resolve
 * (error or timeout) are all refused.
 */
export async function isBlockedAgentRequest(rawUrl: unknown): Promise<boolean> {
  if (typeof rawUrl !== "string") return true;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return true;
  }
  // Never reach the network.
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return false;
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return true;
  const host = u.hostname.toLowerCase();
  const bare = host.startsWith("[") ? host.slice(1, -1) : host.replace(/\.$/, "");
  if (isInternalHost(host) || isInternalHost(bare)) return true;
  const port = effectivePort(u);
  // A loopback target is refused unless its port is allow-listed; a chromium
  // debug port and this server's port never are (isAllowedLoopbackPort).
  const loopbackVerdict = () => !(isAllowedLoopbackPort(port) || loopbackAllowed());
  if (isLoopbackHost(host)) return loopbackVerdict();
  if (isIP(bare)) return false; // a literal that is not loopback
  const r = await resolveHost(bare);
  if (r === "fail") return true;
  return r === "loopback" ? loopbackVerdict() : false;
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

/** Target types that can host frames or spawn further targets: they also auto-attach. */
const FRAME_TYPES = new Set(["page", "iframe"]);

/**
 * Install the guard on the BROWSER-target client. Every target chromium
 * creates from now on (agent tabs, popups from window.open / target=_blank,
 * shared and service workers) is auto-attached paused
 * (`waitForDebuggerOnStart`), given Fetch interception for all URLs, and only
 * then resumed, so nothing it loads escapes the check. Fetch does NOT pause
 * WebSocket handshakes: see the WebSocket note in the finding doc. Pages and frames also auto-attach to what they start (out-of-process
 * iframes, dedicated workers) the same way. Any target, of any type, whose
 * guard cannot be set up is closed and never resumed.
 *
 * Targets that already exist (the tab chromium opened at spawn) are attached
 * as well, and their setup is awaited before this returns; one already
 * showing a blocked URL is sent to about:blank.
 *
 * Private recipe tabs, and pages they open, are released without
 * interception: the server drives them with trusted manifest steps and no
 * agent can reach them. A request from one that was attached before it was
 * known to be private is continued unchecked.
 */
export async function installBrowserNetGuard(cdp: CdpLike, hooks: GuardHooks): Promise<BrowserNetGuard> {
  const sessions = new Map<string, { targetId: string; private: boolean }>();
  const setups = new Set<Promise<void>>();

  cdp.on("Fetch.requestPaused", (p, sid) => {
    void (async () => {
      const requestId = p.requestId;
      let blocked = true; // every error path below fails the request
      try {
        const s = sid ? sessions.get(sid) : undefined;
        if (s) {
          const trusted = s.private || hooks.isPrivate(s.targetId);
          blocked = !trusted && (await isBlockedAgentRequest((p.request as { url?: unknown } | undefined)?.url));
        }
      } catch {
        blocked = true;
      }
      await cdp
        .send(blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
          blocked ? { requestId, errorReason: "BlockedByClient" } : { requestId }, sid)
        .catch(() => {});
    })();
  });

  const onAttached = async (p: Record<string, unknown>, parentSid?: string): Promise<void> => {
    const child = p.sessionId;
    const info = (p.targetInfo ?? {}) as { targetId?: unknown; type?: unknown; openerId?: unknown; url?: unknown };
    if (typeof child !== "string" || typeof info.targetId !== "string") return;
    const targetId = info.targetId;
    const type = typeof info.type === "string" ? info.type : "other";
    let isPrivate = false;
    try {
      const opener = typeof info.openerId === "string" ? info.openerId : undefined;
      isPrivate =
        !!(parentSid && sessions.get(parentSid)?.private) || hooks.isPrivate(targetId) || (!!opener && hooks.isPrivate(opener));
      if (isPrivate && type === "page" && opener) hooks.markPrivate(targetId);
    } catch {
      isPrivate = false; // cannot tell: guard it
    }
    sessions.set(child, { targetId, private: isPrivate });
    if (!isPrivate) {
      try {
        if (type === "worker") {
          // A dedicated worker has no Fetch domain ("'Fetch.enable' wasn't
          // found"); its requests go out through the frame that owns it, which
          // the parent's interception pauses (pinned by the chromium e2e). So
          // it may run only under a guarded parent.
          const parent = parentSid ? sessions.get(parentSid) : undefined;
          if (!parent || parent.private) throw new Error("worker without a guarded parent");
        } else {
          await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, child);
        }
        if (FRAME_TYPES.has(type)) {
          await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
        }
      } catch {
        // Whatever it is, it does not run unguarded: close it, never resume.
        await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        return;
      }
      if (!p.waitingForDebugger && typeof info.url === "string" && /^(https?|wss?):/i.test(info.url)
        && (await isBlockedAgentRequest(info.url).catch(() => true))) {
        await cdp.send("Page.navigate", { url: "about:blank" }, child).catch(() => {});
      }
    }
    // Paused at creation: it has made no request before this point.
    if (p.waitingForDebugger) await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
  };

  cdp.on("Target.attachedToTarget", (p, parentSid) => {
    const setup = onAttached(p, parentSid).catch(() => {});
    setups.add(setup);
    void setup.finally(() => setups.delete(setup));
  });

  cdp.on("Target.detachedFromTarget", (p) => {
    if (typeof p.sessionId === "string") sessions.delete(p.sessionId);
  });

  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // Existing targets were reported while that command ran: finish guarding them first.
  await Promise.all([...setups]);

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
