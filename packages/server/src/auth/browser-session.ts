import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { config } from "../config";
import { activeProfiles, spawnProfileChromium, cdpCall, userProfileDir } from "./profile-chromium";
import { trimProfileCaches } from "./profile-disk";
import { startProxyAuth, filterCookies } from "./cookie";
import { configureDownloads, cancelDownloads } from "./browser-downloads";
import type { CookieData, RawCookie } from "./cookie";

// Persistent CDP client: one long-lived socket to a page target, many
// request/response commands multiplexed by auto-incrementing id.
export class CdpClient {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private gone = false;
  private onGone?: () => void;
  private listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  readonly ready: Promise<void>;

  constructor(wsUrl: string, onGone?: () => void) {
    this.onGone = onGone;
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, origin: "http://127.0.0.1" });
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("open", () => {
        // Fire-and-forget enables; we don't await their replies.
        this.fire("Page.enable");
        this.fire("Runtime.enable");
        resolve();
      });
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw: WebSocket.RawData) => {
      let msg: {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg.id !== "number") {
        // An event frame. Every CDP event used to be dropped on this line —
        // Browser.downloadProgress, Network.responseReceived, all of it — which
        // is why nothing could observe the browser, only command it.
        const set = msg.method ? this.listeners.get(msg.method) : undefined;
        if (set) {
          for (const fn of [...set]) {
            // One misbehaving listener must not take the socket down with it.
            try { fn(msg.params ?? {}); }
            catch (e) { console.warn(`[cdp] listener for ${msg.method} threw:`, e); }
          }
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`cdp: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
    });
    this.ws.on("error", () => this.handleGone());
    this.ws.on("close", () => this.handleGone());
  }

  private fire(method: string, params: Record<string, unknown> = {}): void {
    const id = ++this.id;
    try { this.ws.send(JSON.stringify({ id, method, params })); } catch { /* noop */ }
  }

  private drainPending(err: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  /**
   * Subscribe to a CDP event. Returns an unsubscribe, which callers must use —
   * a long-lived warm session would otherwise accumulate one handler per
   * download.
   */
  on(method: string, fn: (p: Record<string, unknown>) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) { set = new Set(); this.listeners.set(method, set); }
    set.add(fn);
    return () => {
      const current = this.listeners.get(method);
      if (!current) return;
      current.delete(fn);
      if (current.size === 0) this.listeners.delete(method);
    };
  }

  private handleGone(): void {
    if (this.gone) return;
    this.gone = true;
    this.drainPending(new Error("cdp socket closed"));
    // Listeners go too. A waiter subscribed to Browser.downloadProgress has no
    // command in flight, so drainPending cannot reach it and the 10s command
    // timeout does not apply — without this it would hang until its own.
    this.listeners.clear();
    try { this.ws.close(); } catch { /* noop */ }
    this.onGone?.();
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp ${method} timed out`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  close(): void {
    if (this.gone) return;
    this.gone = true;
    this.drainPending(new Error("cdp client closed"));
    try { this.ws.close(); } catch { /* noop */ }
  }
}

/** What the CDP action helpers need: one page-level client and its last screenshot hash. */
export interface PageHandle {
  cdp: CdpClient;
  lastShotHash?: string;
}

export interface Tab extends PageHandle {
  id: string;
  lastActivity: number;
  createdAt: number;
}

function pageWsUrl(remotePort: number, targetId: string): string {
  return `ws://127.0.0.1:${remotePort}/devtools/page/${targetId}`;
}

async function attachTab(s: WarmSession, targetId: string, wsUrl: string): Promise<Tab> {
  const cdp = new CdpClient(wsUrl, () => {
    // Only this tab is gone. Never tear the session down from here: chromium
    // is still up and the other tabs are still driveable.
    const cur = s.tabs.get(targetId);
    if (cur && cur.cdp === cdp) s.tabs.delete(targetId);
  });
  await cdp.ready;
  const now = Date.now();
  const tab: Tab = { id: targetId, cdp, lastActivity: now, createdAt: now };
  s.tabs.set(targetId, tab);
  return tab;
}

export interface WarmSession {
  proc: ChildProcess;
  remotePort: number;
  cdpPageWsUrl: string;
  cdpBrowserWsUrl: string;
  userId: string;
  lastActivity: number;
  /**
   * Page targets this session drives, keyed by chromium targetId. The agent's
   * `session_id` is one of these keys. `defaultTabId` is the page chromium
   * opened at spawn; the live view dials it (`cdpPageWsUrl`) and pre-upgrade
   * agents holding the old routing key are mapped onto it.
   */
  tabs: Map<string, Tab>;
  defaultTabId: string;
  authWs?: WebSocket;
  /**
   * Second client, on the BROWSER target rather than the page target.
   * Browser.setDownloadBehavior and the Browser.download* events live there,
   * and the page-level equivalents are deprecated. Lazy: a session that never
   * downloads should not pay for a second socket.
   */
  browserCdp?: CdpClient;
  /**
   * Memoized download-routing setup. Started in the background at session
   * creation so opening a browser never waits on a second socket, and awaited
   * by anything that actually needs a download to land in the right place.
   */
  downloadRouting?: Promise<void>;
}

const warmSessions = new Map<string, WarmSession>();

export async function ensureSession(userId: string): Promise<WarmSession> {
  const existing = warmSessions.get(userId);
  if (existing) { existing.lastActivity = Date.now(); return existing; }

  if (activeProfiles.has(userId)) {
    throw new Error("BROWSER_SESSION_BUSY: a browser session is already active for this user");
  }
  activeProfiles.add(userId);
  try {
    const spawned = await spawnProfileChromium(userId, {});
    const proxyUser = process.env.CAPTURE_PROXY_USERNAME;
    const proxyPass = process.env.CAPTURE_PROXY_PASSWORD;
    const authWs =
      process.env.CAPTURE_PROXY && proxyUser && proxyPass
        ? startProxyAuth(spawned.cdpBrowserWsUrl, proxyUser, proxyPass)
        : undefined;
    const session: WarmSession = {
      proc: spawned.proc,
      remotePort: spawned.remotePort,
      cdpPageWsUrl: spawned.cdpPageWsUrl,
      cdpBrowserWsUrl: spawned.cdpBrowserWsUrl,
      userId,
      lastActivity: Date.now(),
      tabs: new Map(),
      defaultTabId: spawned.cdpPageTargetId,
      authWs,
    };
    await attachTab(session, spawned.cdpPageTargetId, spawned.cdpPageWsUrl);
    warmSessions.set(userId, session);
    // Kick off download routing, but do not block on it: opening a browser
    // must not wait on a second socket, and must not hang if that socket never
    // comes up. Anything that needs a download to land calls
    // ensureDownloadRouting and awaits the same promise.
    void ensureDownloadRouting(session).catch(() => undefined);
    spawned.proc.on("exit", () => {
      activeProfiles.delete(userId);
      warmSessions.delete(userId);
      cancelDownloads(userId);
      for (const t of session.tabs.values()) { try { t.cdp.close(); } catch { /* noop */ } }
      session.tabs.clear();
      try { session.browserCdp?.close(); } catch { /* noop */ }
      try { session.authWs?.close(); } catch { /* noop */ }
      // The profile outlives the process on purpose — that's what keeps the user
      // logged in. Its caches don't: reclaim them here so disk cost tracks the
      // number of users, not the number of sessions they've ever run. Hooked on
      // exit rather than in closeBrowserSession so a crashed or reaped chromium
      // is cleaned up the same way. Fire-and-forget; the lock is already released
      // and the process is dead, so nothing is holding these files open.
      void trimProfileCaches(userProfileDir(userId)).catch(() => undefined);
    });
    return session;
  } catch (e) {
    activeProfiles.delete(userId);
    throw e;
  }
}

/**
 * Point this session's downloads at its owner's workspace, once.
 *
 * Memoized on the session: every caller awaits the same promise, so arming a
 * download is cheap after the first and correct on the first.
 */
export function ensureDownloadRouting(s: WarmSession): Promise<void> {
  if (!s.downloadRouting) {
    s.downloadRouting = (async () => {
      const client = await browserClient(s);
      await configureDownloads(s.userId, client);
    })().catch((e) => {
      // Let a later attempt retry rather than caching the failure forever.
      s.downloadRouting = undefined;
      console.warn(`[browser] download routing unavailable for ${s.userId}:`, e);
      throw e;
    });
  }
  return s.downloadRouting;
}

/** The browser-target client, created on first use and cached on the session. */
export async function browserClient(s: WarmSession): Promise<CdpClient> {
  if (s.browserCdp) return s.browserCdp;
  const client = new CdpClient(s.cdpBrowserWsUrl);
  await client.ready;
  s.browserCdp = client;
  return client;
}

export function touch(userId: string): void {
  const s = warmSessions.get(userId);
  if (s) s.lastActivity = Date.now();
}

export function getWarmSession(userId: string): WarmSession | undefined {
  return warmSessions.get(userId);
}

export function getTab(userId: string, tabId: string): Tab | undefined {
  return warmSessions.get(userId)?.tabs.get(tabId);
}

export function touchTab(userId: string, tabId: string): void {
  const s = warmSessions.get(userId);
  if (!s) return;
  const now = Date.now();
  s.lastActivity = now;
  const t = s.tabs.get(tabId);
  if (t) t.lastActivity = now;
}

export type OpenTabResult =
  | { ok: true; tab: Tab }
  | { ok: false; error: "BROWSER_TAB_LIMIT"; limit: number };

/** Open a fresh about:blank tab in this user's chromium and register it. */
export async function openTab(userId: string): Promise<OpenTabResult> {
  const s = await ensureSession(userId);
  const limit = config.BROWSER_TAB_LIMIT;
  if (s.tabs.size >= limit) return { ok: false, error: "BROWSER_TAB_LIMIT", limit };
  const browser = await browserClient(s);
  const { targetId } = (await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const tab = await attachTab(s, targetId, pageWsUrl(s.remotePort, targetId));
  s.lastActivity = Date.now();
  return { ok: true, tab };
}

/**
 * The default tab, ensuring the session. If the default was closed, adopt the
 * first live page target (or create one) so the live view and compat callers
 * always have somewhere to land.
 */
export async function defaultTab(userId: string): Promise<Tab> {
  const s = await ensureSession(userId);
  const existing = s.tabs.get(s.defaultTabId);
  if (existing) return existing;
  const browser = await browserClient(s);
  const { targetInfos } = (await browser.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId: string; type: string }>;
  };
  let targetId = targetInfos?.find((t) => t.type === "page")?.targetId;
  if (!targetId) {
    targetId = ((await browser.send("Target.createTarget", { url: "about:blank" })) as { targetId: string }).targetId;
  }
  const tab = s.tabs.get(targetId) ?? (await attachTab(s, targetId, pageWsUrl(s.remotePort, targetId)));
  s.defaultTabId = targetId;
  s.cdpPageWsUrl = pageWsUrl(s.remotePort, targetId);
  return tab;
}

/** Close one tab. False when it is not a tab of this user's session. */
export async function closeTab(userId: string, tabId: string): Promise<boolean> {
  const s = warmSessions.get(userId);
  const tab = s?.tabs.get(tabId);
  if (!s || !tab) return false;
  s.tabs.delete(tabId);
  try { tab.cdp.close(); } catch { /* noop */ }
  try {
    const browser = await browserClient(s);
    await browser.send("Target.closeTarget", { targetId: tabId });
  } catch { /* target already gone */ }
  s.lastActivity = Date.now();
  return true;
}

export interface TabInfo { id: string; url: string; title: string; active: boolean }

/** Every page target in the user's chromium; `active` = driveable through a registered tab. */
export async function listTabs(userId: string): Promise<TabInfo[]> {
  const s = await ensureSession(userId);
  const browser = await browserClient(s);
  const { targetInfos } = (await browser.send("Target.getTargets")) as {
    targetInfos?: Array<{ targetId: string; type: string; url: string; title: string }>;
  };
  return (targetInfos ?? [])
    .filter((t) => t.type === "page")
    .map((t) => ({ id: t.targetId, url: t.url, title: t.title, active: s.tabs.has(t.targetId) }));
}

// Read the user's live browser cookies, scoped to an integration's domains.
// A pure read over the existing session's browser-level CDP endpoint — does not
// store and does not tear the session down. Throws if the user has no session.
export async function captureLiveCookies(
  userId: string,
  targetDomain: string,
  cookieDomains: string[] = []
): Promise<CookieData> {
  const session = warmSessions.get(userId);
  if (!session) throw new Error("No browser session for user");
  const result = (await cdpCall(session.cdpBrowserWsUrl, "Storage.getCookies", {})) as {
    cookies: RawCookie[];
  };
  return {
    domain: targetDomain,
    cookies: filterCookies(result.cookies, [targetDomain, ...cookieDomains]),
    capturedAt: Math.floor(Date.now() / 1000),
  };
}

export async function closeBrowserSession(userId: string): Promise<void> {
  const s = warmSessions.get(userId);
  if (!s) return;
  warmSessions.delete(userId);
  activeProfiles.delete(userId);
  cancelDownloads(userId);
  for (const t of s.tabs.values()) { try { t.cdp.close(); } catch { /* noop */ } }
  s.tabs.clear();
  try { s.browserCdp?.close(); } catch { /* noop */ }
  try { s.authWs?.close(); } catch { /* noop */ }
  try { s.proc.kill("SIGKILL"); } catch { /* noop */ }
}

export function reapIdleSessions(now = Date.now()): void {
  const cutoff = now - config.BROWSER_SESSION_TTL_SECONDS * 1000;
  for (const [userId, s] of warmSessions) {
    if (s.lastActivity < cutoff) void closeBrowserSession(userId);
  }
}

let reaperStarted = false;
export function startBrowserReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  setInterval(() => reapIdleSessions(), 30_000).unref();
}

// ─── CDP action helpers ───────────────────────────────────────────────────
// Each takes a PageHandle (a tab) and speaks CDP through its page-level client.

export async function navigate(
  s: PageHandle,
  url: string
): Promise<{ url: string; title: string }> {
  await s.cdp.send("Page.navigate", { url });
  // Give the load a moment; Page.loadEventFired isn't awaited here to keep
  // the helper simple — a short settle covers most SPAs. (Follow-up: await
  // the load event.)
  await new Promise((r) => setTimeout(r, 800));
  const title = await pageTitle(s);
  return { url, title };
}

async function pageTitle(s: PageHandle): Promise<string> {
  try {
    const r = (await s.cdp.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    const v = r.result?.value;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

export interface ShotOpts { format?: "jpeg" | "png"; quality?: number; maxWidth?: number }

export async function screenshot(
  s: PageHandle,
  opts: ShotOpts = {}
): Promise<{ _mcpImage: { data: string; mimeType: string } } | { unchanged: true }> {
  const format = opts.format ?? "jpeg";
  const quality = opts.quality ?? 60;
  const maxWidth = opts.maxWidth ?? 1000;

  const metrics = (await s.cdp.send("Page.getLayoutMetrics")) as {
    cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    layoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const vp = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
  const vw = vp.clientWidth ?? 1280;
  const vh = vp.clientHeight ?? 800;
  const scale = Math.min(1, maxWidth / vw);

  const params: Record<string, unknown> = { format, clip: { x: 0, y: 0, width: vw, height: vh, scale } };
  if (format === "jpeg") params.quality = quality;

  const r = (await s.cdp.send("Page.captureScreenshot", params)) as { data?: string };
  const data = r.data ?? "";
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash === s.lastShotHash) return { unchanged: true };
  s.lastShotHash = hash;
  return { _mcpImage: { data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" } };
}

type MouseButton = "left" | "right" | "middle";
export async function click(s: PageHandle, x: number, y: number, button: MouseButton = "left"): Promise<void> {
  await s.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
  await s.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
}

export async function typeText(s: PageHandle, text: string): Promise<void> {
  await s.cdp.send("Input.insertText", { text });
}

// Minimal key map for the common driving keys. Chords like "ctrl+a" parse the
// trailing token as the key and the leading tokens as modifiers.
const MODIFIERS: Record<string, number> = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
const KEYS: Record<string, { keyCode: number; key: string }> = {
  enter: { keyCode: 13, key: "Enter" },
  tab: { keyCode: 9, key: "Tab" },
  escape: { keyCode: 27, key: "Escape" },
  esc: { keyCode: 27, key: "Escape" },
  backspace: { keyCode: 8, key: "Backspace" },
  delete: { keyCode: 46, key: "Delete" },
  arrowup: { keyCode: 38, key: "ArrowUp" },
  arrowdown: { keyCode: 40, key: "ArrowDown" },
  arrowleft: { keyCode: 37, key: "ArrowLeft" },
  arrowright: { keyCode: 39, key: "ArrowRight" },
};

export async function pressKey(s: PageHandle, keys: string): Promise<void> {
  const parts = keys.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  let modifiers = 0;
  let last = "";
  for (const p of parts) {
    if (MODIFIERS[p] !== undefined) modifiers |= MODIFIERS[p];
    else last = p;
  }
  const mapped = KEYS[last];
  if (!mapped && last.length === 1 && modifiers === 0) {
    // Printable char: keyDown with text actually inserts it.
    await s.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: last, text: last, modifiers });
    await s.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: last, modifiers });
    return;
  }
  const base: Record<string, unknown> = mapped
    ? { windowsVirtualKeyCode: mapped.keyCode, key: mapped.key, modifiers }
    : { key: last, modifiers };
  await s.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await s.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

type ScrollDir = "up" | "down" | "left" | "right";
export async function scroll(s: PageHandle, direction: ScrollDir, amount = 600): Promise<void> {
  const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
  await s.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX, deltaY });
}

export async function readText(s: PageHandle, maxChars = 20000): Promise<{ text: string; truncated: boolean }> {
  const r = (await s.cdp.send("Runtime.evaluate", {
    expression: "document.body.innerText",
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const full = typeof r.result?.value === "string" ? r.result.value : "";
  const truncated = full.length > maxChars;
  return { text: truncated ? full.slice(0, maxChars) : full, truncated };
}

// Bound on the serialized value handed back from evaluate. Past it the
// answer is an error, not a truncated value: a sliced JSON string is not
// JSON, and a sliced outerHTML is exactly the kind of thing that parses
// and misleads.
export const EVALUATE_MAX_CHARS = 100_000;

export interface EvaluateOpts { awaitPromise?: boolean; timeoutMs?: number }

export type EvaluateResult =
  | { value: unknown; type: string }
  | { error: "EVALUATION_FAILED"; detail: string }
  | { error: "RESULT_TOO_LARGE"; chars: number; max: number };

// Run JavaScript in the page and return its value — the Playwright
// `page.evaluate` shape. returnByValue means DOM nodes and functions come
// back as {} rather than a handle; return a plain value from the expression.
export async function evaluate(
  s: PageHandle,
  expression: string,
  opts: EvaluateOpts = {}
): Promise<EvaluateResult> {
  const r = (await s.cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? true,
    userGesture: true,
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  })) as {
    result?: { type?: string; value?: unknown; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation threw";
    return { error: "EVALUATION_FAILED", detail };
  }
  const value = r.result?.value;
  const chars = value === undefined ? 0 : JSON.stringify(value).length;
  if (chars > EVALUATE_MAX_CHARS) return { error: "RESULT_TOO_LARGE", chars, max: EVALUATE_MAX_CHARS };
  return { value, type: r.result?.type ?? "undefined" };
}
