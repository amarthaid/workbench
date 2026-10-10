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

import { Resolver } from "node:dns/promises";
import { readFileSync, statSync } from "node:fs";
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
/** Paused requests one chromium may have awaiting a verdict; past it they are failed at once. */
const MAX_PENDING = 512;

type Resolved = "loopback" | "public" | "fail";

const dnsResolver = new Resolver({ timeout: 900, tries: 2 });

/** Test seams. */
export const __netGuard = {
  // c-ares queries, not dns.lookup: getaddrinfo runs on libuv's small shared
  // threadpool (4 threads by default), so a few hung lookups from one page
  // would stall every session's lookups (and fs work). c-ares is asynchronous
  // and needs no thread. It does not read /etc/hosts or apply search domains
  // the way chromium's resolver does; both are handled in the resolver below.
  //
  // A and AAAA are both asked. NODATA for one family is "no records"; any
  // other error on either family throws, so the request is failed: chromium
  // might get an answer the guard never saw.
  async resolve(host: string): Promise<string[]> {
    const one = (f: 4 | 6) =>
      __netGuard.query(host, f).catch((e: { code?: string }) => {
        if (e?.code === "ENODATA") return [] as string[];
        throw e;
      });
    const [v4, v6] = await Promise.all([one(4), one(6)]);
    const addrs = [...v4, ...v6];
    if (!addrs.length) throw new Error("unresolved");
    return addrs;
  },
  query: (h: string, f: 4 | 6): Promise<string[]> => (f === 4 ? dnsResolver.resolve4(h) : dnsResolver.resolve6(h)),
  /** Overrides for /etc/hosts and /etc/resolv.conf content (tests). */
  hostsText: undefined as string | undefined,
  resolvConfText: undefined as string | undefined,
  hostsPath: "/etc/hosts",
  resolvConfPath: "/etc/resolv.conf",
  /** Reads a system file; throws on error or past MAX_SYSTEM_FILE_BYTES. */
  readFile: (path: string): string => readCapped(path),
  /** Forget both snapshots (tests). */
  resetSystemFiles(): void {
    hostsSnap = undefined;
    resolvSnap = undefined;
    sysCache = undefined;
  },
  /** Make the next check re-read the files, keeping the snapshots (tests). */
  expireSystemFiles(): void {
    sysCache = undefined;
  },
  /** Successful answers only (shared: real DNS data). Failures are cached per resolver. */
  cache: new Map<string, { at: number; result: Exclude<Resolved, "fail"> }>(),
  /** Overall bound for one request's decision: queue + lookup. Past it the request is failed. */
  timeoutMs: 2_000,
  /** Per resolver (per session). */
  maxConcurrent: 8,
  maxQueue: 32,
};

/** The test-only opt-out. Never honoured in production. */
function loopbackAllowed(): boolean {
  return config.BROWSER_ALLOW_LOOPBACK && process.env.NODE_ENV !== "production";
}

const SYSTEM_FILES_TTL_MS = 30_000;
const MAX_SYSTEM_FILE_BYTES = 1_048_576;

function readCapped(path: string): string {
  if (statSync(path).size > MAX_SYSTEM_FILE_BYTES) throw new Error("system file too large");
  const text = readFileSync(path, "utf8");
  if (text.length > MAX_SYSTEM_FILE_BYTES) throw new Error("system file too large");
  return text;
}

/** Read through the seam, refusing to parse past the cap (the last snapshot then stays). */
function readSystem(path: string): string {
  const text = __netGuard.readFile(path);
  if (text.length > MAX_SYSTEM_FILE_BYTES) throw new Error("system file too large");
  return text;
}

// The last good parse of each file. A failed or oversized read keeps it; with
// no snapshot at all the lists are unknown and every name is refused.
let hostsSnap: Set<string> | undefined;
let resolvSnap: { search: string[]; ndots: number } | undefined;
let sysCache:
  | { at: number; hostsText?: string; resolvText?: string; hosts?: Set<string>; resolv?: { search: string[]; ndots: number } }
  | undefined;

function parseHosts(text: string): Set<string> {
  const hosts = new Set<string>();
  for (const line of text.split("\n")) {
    const hash = line.indexOf("#");
    const fields = (hash >= 0 ? line.slice(0, hash) : line).trim().split(/\s+/).filter(Boolean);
    for (const name of fields.slice(1)) hosts.add(normaliseHost(name));
  }
  return hosts;
}

function parseResolv(text: string): { search: string[]; ndots: number } {
  let search: string[] = [];
  let ndots = 1;
  for (const line of text.split("\n")) {
    const cut = line.search(/[#;]/);
    const f = (cut >= 0 ? line.slice(0, cut) : line).trim().split(/\s+/);
    if (f[0] === "search" || f[0] === "domain") search = f.slice(1).map(normaliseHost).filter(Boolean).slice(0, 6);
    if (f[0] === "options") for (const o of f.slice(1)) {
      if (o.startsWith("ndots:") && /^\d{1,3}$/.test(o.slice(6))) ndots = Math.min(15, Number(o.slice(6)));
    }
  }
  return { search, ndots };
}

/**
 * What chromium's resolver also consults: every name in /etc/hosts, and the
 * search list + ndots from /etc/resolv.conf. Re-read on a short TTL; a read
 * that fails keeps the last good snapshot. `undefined` lists mean unknown:
 * the caller must refuse every non-literal host.
 */
function systemFiles(): { hosts?: Set<string>; resolv?: { search: string[]; ndots: number } } {
  const now = Date.now();
  if (sysCache && now - sysCache.at < SYSTEM_FILES_TTL_MS
    && sysCache.hostsText === __netGuard.hostsText && sysCache.resolvText === __netGuard.resolvConfText) return sysCache;
  if (__netGuard.hostsText !== undefined) hostsSnap = parseHosts(__netGuard.hostsText);
  else {
    try { hostsSnap = parseHosts(readSystem(__netGuard.hostsPath)); } catch { /* keep the last snapshot */ }
  }
  if (__netGuard.resolvConfText !== undefined) resolvSnap = parseResolv(__netGuard.resolvConfText);
  else {
    try { resolvSnap = parseResolv(readSystem(__netGuard.resolvConfPath)); } catch { /* keep the last snapshot */ }
  }
  sysCache = { at: now, hostsText: __netGuard.hostsText, resolvText: __netGuard.resolvConfText, hosts: hostsSnap, resolv: resolvSnap };
  return sysCache;
}

/** Lowercase, no trailing dots. A linear loop: `/\.+$/` backtracks quadratically. */
export function normaliseHost(h: string): string {
  let end = h.length;
  while (end > 0 && h.charCodeAt(end - 1) === 46 /* . */) end -= 1;
  return h.slice(0, end).toLowerCase();
}

/** DNS names are at most 253 characters (one more with a trailing dot). */
export const MAX_HOST_LENGTH = 253;

/**
 * Names chromium may actually query for `host`: the name itself and, when it
 * has fewer dots than ndots, each search-domain expansion.
 */
function candidatesFor(host: string): string[] {
  const resolv = systemFiles().resolv;
  if (!resolv) return [host]; // callers refuse the host first when the lists are unknown
  const { search, ndots } = resolv;
  let dots = 0;
  for (let i = 0; i < host.length && dots < ndots; i++) if (host.charCodeAt(i) === 46) dots += 1;
  return dots < ndots ? [host, ...search.map((d) => `${host}.${d}`)] : [host];
}

/**
 * DNS for one user's chromium. Lookups, their queue and negative results are
 * per resolver (one per guard, so per session), so a page that floods slow or
 * unresolvable hostnames only slows its own session. Successful answers are
 * real DNS data and are shared (__netGuard.cache). Every wait (queue slot, a
 * lookup another request started, the lookup itself) is bounded by the
 * caller's own deadline; past it, or when the queue is full, the request is
 * failed.
 */
export interface DnsResolver {
  resolve(host: string, deadline: number): Promise<Resolved>;
}

export function createDnsResolver(): DnsResolver {
  let active = 0;
  const waiting: Array<() => void> = [];
  const inFlight = new Map<string, Promise<Resolved>>();
  const negative = new Map<string, number>(); // host -> expires at

  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  /** Resolves true when a slot is held, false on overflow or deadline. */
  const acquire = (deadline: number): Promise<boolean> => {
    if (active < __netGuard.maxConcurrent) {
      active += 1;
      return Promise.resolve(true);
    }
    if (waiting.length >= __netGuard.maxQueue) return Promise.resolve(false);
    return new Promise<boolean>((res) => {
      let done = false;
      const grant = () => {
        if (done) { waiting.shift()?.(); return; } // timed out already: pass the slot on
        done = true;
        clearTimeout(timer);
        active += 1;
        res(true);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = waiting.indexOf(grant);
        if (i >= 0) waiting.splice(i, 1);
        res(false);
      }, Math.max(0, deadline - Date.now()));
      waiting.push(grant);
    });
  };

  /**
   * "busy" is the guard's own limit (queue overflow, deadline), not something
   * DNS said: it fails the request but is never cached.
   */
  const lookupOnce = async (host: string, deadline: number): Promise<Resolved | "busy"> => {
    if (!(await acquire(deadline))) return "busy";
    try {
      // Every name chromium might use for `host`. The name itself must resolve
      // cleanly; an expansion that does not exist is skipped (NXDOMAIN /
      // NODATA), but any other error on it fails. Loopback anywhere fails.
      const [self, ...expansions] = candidatesFor(host);
      const results = await bounded(
        Promise.all([
          __netGuard.resolve(self).then((a) => ({ ok: true as const, a }), () => ({ ok: false as const, a: [] as string[] })),
          ...expansions.map((c) =>
            __netGuard.resolve(c).then(
              (a) => ({ ok: true as const, a }),
              (e: { code?: string; message?: string }) =>
                e?.code === "ENOTFOUND" || e?.message === "unresolved"
                  ? { ok: true as const, a: [] as string[] }
                  : { ok: false as const, a: [] as string[] }
            )
          ),
        ]),
        deadline
      );
      if (!results) return "busy";
      if (results.some((r) => !r.ok)) return "fail";
      const all = results.flatMap((r) => r.a);
      if (!all.length) return "fail";
      return all.some(isLoopbackAddress) ? "loopback" : "public";
    } catch {
      return "fail"; // NXDOMAIN, SERVFAIL: fail closed
    } finally {
      // The underlying lookup may still be running (a hung resolver), but this
      // session's slot is returned at the deadline, so it cannot pin the queue.
      release();
    }
  };

  return {
    async resolve(host: string, deadline: number): Promise<Resolved> {
      const now = Date.now();
      // The verdict covers every name chromium may query (search expansions), so
      // the cache key does too: a resolv.conf change cannot reuse a stale verdict.
      const key = candidatesFor(host).join("\n");
      const hit = __netGuard.cache.get(key);
      if (hit && now - hit.at < DNS_CACHE_MS) return hit.result;
      const neg = negative.get(key);
      if (neg !== undefined && neg > now) return "fail";
      let p = inFlight.get(key);
      if (!p) {
        p = lookupOnce(host, now + __netGuard.timeoutMs)
          .then((result): Resolved => {
            if (result === "busy") return "fail"; // our own limit: fail, remember nothing
            if (result === "fail") {
              if (negative.size >= DNS_CACHE_MAX) negative.clear();
              negative.set(key, Date.now() + DNS_NEGATIVE_CACHE_MS);
            } else {
              if (__netGuard.cache.size >= DNS_CACHE_MAX) __netGuard.cache.clear();
              __netGuard.cache.set(key, { at: Date.now(), result });
            }
            return result;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, p);
      }
      // Waiting on someone else's lookup is bounded by this request's deadline.
      return (await bounded(p, deadline)) ?? "fail";
    },
  };
}

/** `p`, or undefined once `deadline` passes. Never rejects. */
function bounded<T>(p: Promise<T>, deadline: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, deadline - Date.now())); }),
  ]).finally(() => clearTimeout(timer));
}

/** Used where no guard-scoped resolver is passed (tests, one-off checks). */
const defaultResolver = createDnsResolver();

/**
 * True when an agent target must not send this request. Fails closed: an
 * unparsable URL, an unknown scheme, and a hostname that does not resolve
 * (error or timeout) are all refused.
 */
export async function isBlockedAgentRequest(rawUrl: unknown, resolver: DnsResolver = defaultResolver): Promise<boolean> {
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
  // Before any other processing: an over-long host cannot be a real name, and
  // every later step is at least linear in its length.
  if (u.hostname.length > MAX_HOST_LENGTH + 1) return true;
  const host = u.hostname.toLowerCase();
  const bare = host.startsWith("[") ? host.slice(1, -1) : normaliseHost(host);
  if (bare.length > MAX_HOST_LENGTH) return true;
  if (isInternalHost(host) || isInternalHost(bare)) return true;
  const port = effectivePort(u);
  // A loopback target is refused unless its port is allow-listed; a chromium
  // debug port and this server's port never are (isAllowedLoopbackPort).
  const loopbackVerdict = () => !(isAllowedLoopbackPort(port) || loopbackAllowed());
  if (isLoopbackHost(host)) return loopbackVerdict();
  if (isIP(bare)) return false; // a literal that is not loopback
  // Chromium's resolver reads /etc/hosts first; c-ares here does not. Any
  // name the hosts file knows (as itself or a search expansion) is refused
  // unless its port is allow-listed, whatever public DNS says.
  const { hosts, resolv } = systemFiles();
  // Unreadable /etc/hosts or resolv.conf and no earlier snapshot: what chromium
  // would resolve is unknown, so refuse.
  if (!hosts || !resolv) return true;
  if (candidatesFor(bare).some((c) => hosts.has(c))) return loopbackVerdict();
  // A single-label name only means something through search domains or the
  // hosts file: refused.
  if (!bare.includes(".")) return true;
  const r = await resolver.resolve(bare, Date.now() + __netGuard.timeoutMs);
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
  const dns = createDnsResolver(); // this chromium's own DNS budget
  let pending = 0; // paused requests awaiting a verdict

  cdp.on("Fetch.requestPaused", (p, sid) => {
    void (async () => {
      const requestId = p.requestId;
      let blocked = true; // every error path below fails the request
      pending += 1;
      try {
        const s = sid ? sessions.get(sid) : undefined;
        if (s && pending <= MAX_PENDING) {
          const trusted = s.private || hooks.isPrivate(s.targetId);
          if (trusted) blocked = false;
          else {
            // Hard bound: whatever the decision does, the request is answered.
            const verdict = await bounded(
              isBlockedAgentRequest((p.request as { url?: unknown } | undefined)?.url, dns),
              Date.now() + __netGuard.timeoutMs + 250
            );
            blocked = verdict !== false;
          }
        }
      } catch {
        blocked = true;
      } finally {
        pending -= 1;
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
        && ((await bounded(isBlockedAgentRequest(info.url, dns), Date.now() + __netGuard.timeoutMs + 250)) !== false)) {
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
