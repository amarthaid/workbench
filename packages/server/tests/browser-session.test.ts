import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { spawnMock, cdpCallMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  cdpCallMock: vi.fn(),
}));
const { proxyAuthMock } = vi.hoisted(() => ({ proxyAuthMock: vi.fn(() => ({ close: vi.fn() })) }));

vi.mock("../src/auth/profile-chromium", async () => {
  const real = await vi.importActual<typeof import("../src/auth/profile-chromium")>(
    "../src/auth/profile-chromium"
  );
  return {
    ...real,
    activeProfiles: new Set<string>(),
    spawnProfileChromium: spawnMock,
    cdpCall: cdpCallMock,
  };
});

vi.mock("../src/auth/cookie", async () => {
  const real = await vi.importActual<typeof import("../src/auth/cookie")>("../src/auth/cookie");
  return { ...real, startProxyAuth: proxyAuthMock };
});

// CdpClient opens a `ws`; emit "open" so its `ready` promise resolves. Enables
// are fire-and-forget so no reply frame is needed.
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor() {
      super();
      setImmediate(() => this.emit("open"));
    }
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

import {
  ensureSession,
  getWarmSession,
  closeBrowserSession,
  reapIdleSessions,
  captureLiveCookies,
  openTab,
  getTab,
  defaultTab,
  closeTab,
  listTabs,
  touchTab,
  browserClient,
} from "../src/auth/browser-session";
import { activeProfiles } from "../src/auth/profile-chromium";

function fakeProc() {
  const { EventEmitter } = require("node:events");
  const p = new EventEmitter();
  p.kill = vi.fn();
  return p;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue({
    proc: fakeProc(),
    remotePort: 9999,
    cdpBrowserWsUrl: "ws://127.0.0.1:9999/browser",
    cdpPageWsUrl: "ws://127.0.0.1:9999/page",
    cdpPageTargetId: "T0",
  });
  activeProfiles.clear();
});

describe("reapIdleSessions", () => {
  it("reapIdleSessions closes a session idle past the TTL", async () => {
    await ensureSession("user-r");
    expect(getWarmSession("user-r")).toBeDefined();
    // far-future now → any session is past the TTL cutoff
    reapIdleSessions(Date.now() + 10_000_000);
    expect(getWarmSession("user-r")).toBeUndefined();
    expect(activeProfiles.has("user-r")).toBe(false);
  });
});

describe("ensureSession proxy-auth wiring", () => {
  beforeEach(() => { proxyAuthMock.mockClear(); });
  afterEach(async () => {
    delete process.env.CAPTURE_PROXY;
    delete process.env.CAPTURE_PROXY_USERNAME;
    delete process.env.CAPTURE_PROXY_PASSWORD;
    await closeBrowserSession("user-proxy");
    await closeBrowserSession("user-noproxy");
    await closeBrowserSession("user-proxy-close");
  });

  it("opens a proxy-auth socket when CAPTURE_PROXY + creds are set", async () => {
    process.env.CAPTURE_PROXY = "http://proxy:8080";
    process.env.CAPTURE_PROXY_USERNAME = "u";
    process.env.CAPTURE_PROXY_PASSWORD = "p";
    await ensureSession("user-proxy");
    expect(proxyAuthMock).toHaveBeenCalledWith("ws://127.0.0.1:9999/browser", "u", "p");
  });

  it("does not open a proxy-auth socket without proxy env", async () => {
    await ensureSession("user-noproxy");
    expect(proxyAuthMock).not.toHaveBeenCalled();
  });

  it("closes the proxy-auth socket when closeBrowserSession is called", async () => {
    process.env.CAPTURE_PROXY = "http://proxy:8080";
    process.env.CAPTURE_PROXY_USERNAME = "u";
    process.env.CAPTURE_PROXY_PASSWORD = "p";
    await ensureSession("user-proxy-close");
    const mockWs = proxyAuthMock.mock.results[0].value;
    await closeBrowserSession("user-proxy-close");
    expect(mockWs.close).toHaveBeenCalled();
  });
});

describe("ensureSession", () => {
  it("launches a session once and reuses it", async () => {
    const a = await ensureSession("user-x");
    const b = await ensureSession("user-x");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    await closeBrowserSession("user-x");
  });

  it("acquires the activeProfiles lock", async () => {
    await ensureSession("user-y");
    expect(activeProfiles.has("user-y")).toBe(true);
    await closeBrowserSession("user-y");
    expect(activeProfiles.has("user-y")).toBe(false);
  });

  it("throws BROWSER_SESSION_BUSY when the lock is already held", async () => {
    activeProfiles.add("user-z");
    await expect(ensureSession("user-z")).rejects.toThrow("BROWSER_SESSION_BUSY");
  });

  it("exposes the page WS on the session and forgets it on close", async () => {
    // The live-view bridge reads cdpPageWsUrl off the session it gets from
    // ensureSession; there is no separate endpoint token to check any more —
    // the portal bearer is the authority (see auth/cdp-bridge.ts).
    const s = await ensureSession("user-t");
    expect(s.cdpPageWsUrl).toBe("ws://127.0.0.1:9999/page");
    expect(getWarmSession("user-t")).toBe(s);
    await closeBrowserSession("user-t");
    expect(getWarmSession("user-t")).toBeUndefined();
  });
});

describe("captureLiveCookies", () => {
  const now = Math.floor(Date.now() / 1000);
  beforeEach(() => { cdpCallMock.mockReset(); });
  afterEach(async () => {
    await closeBrowserSession("user-cap");
    await closeBrowserSession("user-cap2");
  });;

  it("filters live CDP cookies to the integration's domains", async () => {
    await ensureSession("user-cap");
    cdpCallMock.mockResolvedValue({
      cookies: [
        { name: "live", value: "1", domain: ".jira.com", path: "/", expires: now + 86400 },
        { name: "other", value: "2", domain: "evil.com", path: "/", expires: now + 86400 },
      ],
    });
    const data = await captureLiveCookies("user-cap", "jira.com", []);
    expect(data.domain).toBe("jira.com");
    expect(data.cookies.map((c) => c.name)).toEqual(["live"]);
    expect(cdpCallMock).toHaveBeenCalledWith("ws://127.0.0.1:9999/browser", "Storage.getCookies", {});
  });

  it("throws when no session exists for the user", async () => {
    await expect(captureLiveCookies("nobody", "jira.com", [])).rejects.toThrow(/no browser session/i);
  });

  it("includes cookies on a secondary cookieDomain", async () => {
    await ensureSession("user-cap2");
    cdpCallMock.mockResolvedValue({
      cookies: [
        { name: "primary", value: "1", domain: "jira.com", path: "/", expires: now + 86400 },
        { name: "secondary", value: "2", domain: ".atlassian.net", path: "/", expires: now + 86400 },
        { name: "unrelated", value: "3", domain: "evil.com", path: "/", expires: now + 86400 },
      ],
    });
    const data = await captureLiveCookies("user-cap2", "jira.com", ["atlassian.net"]);
    expect(data.cookies.map((c) => c.name).sort()).toEqual(["primary", "secondary"]);
  });
});

// browserClient opens a second FakeWebSocket on the browser target; Target.*
// replies come from cdpSend below, patched onto that client after creation.
async function stubBrowserTarget(userId: string, replies: Record<string, unknown>) {
  const s = getWarmSession(userId)!;
  const client = await browserClient(s);
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  (client as unknown as { send: unknown }).send = vi.fn(
    async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      const r = replies[method];
      return typeof r === "function" ? r(params) : (r ?? {});
    }
  );
  return sent;
}

describe("tabs", () => {
  afterEach(async () => { await closeBrowserSession("u1"); });

  it("ensureSession registers the spawn's page as the default tab", async () => {
    const s = await ensureSession("u1");
    expect(s.defaultTabId).toBe("T0");
    expect(s.tabs.get("T0")).toMatchObject({ id: "T0" });
    expect(s.cdpPageWsUrl).toBe("ws://127.0.0.1:9999/page");
  });

  it("openTab creates a target, registers it under its id, and returns it", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    expect(r).toMatchObject({ ok: true, tab: { id: "T1" } });
    expect(sent).toContainEqual({ method: "Target.createTarget", params: { url: "about:blank" } });
    expect(getTab("u1", "T1")).toBeDefined();
    expect(getWarmSession("u1")!.tabs.size).toBe(2);
  });

  it("openTab refuses past BROWSER_TAB_LIMIT", async () => {
    await ensureSession("u1");
    let n = 0;
    await stubBrowserTarget("u1", { "Target.createTarget": () => ({ targetId: `T${++n}` }) });
    for (let i = 1; i < 8; i++) expect((await openTab("u1")).ok).toBe(true); // 7 + default = 8
    const r = await openTab("u1");
    expect(r).toEqual({ ok: false, error: "BROWSER_TAB_LIMIT", limit: 8 });
  });

  it("closeTab closes the target and removes only that tab; the session stays warm", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    await openTab("u1");
    expect(await closeTab("u1", "T1")).toBe(true);
    expect(sent).toContainEqual({ method: "Target.closeTarget", params: { targetId: "T1" } });
    expect(getTab("u1", "T1")).toBeUndefined();
    expect(getWarmSession("u1")).toBeDefined();
    expect(await closeTab("u1", "nope")).toBe(false);
  });

  it("a tab whose socket dies is dropped without taking the session down", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    if (!r.ok) throw new Error("open failed");
    (r.tab.cdp as unknown as { ws: { emit: (e: string) => void } }).ws.emit("close");
    expect(getTab("u1", "T1")).toBeUndefined();
    expect(getWarmSession("u1")).toBeDefined();
  });

  it("defaultTab re-registers from Target.getTargets when the default was closed", async () => {
    await ensureSession("u1");
    const sent = await stubBrowserTarget("u1", {
      "Target.getTargets": { targetInfos: [{ targetId: "T9", type: "page", url: "about:blank", title: "" }] },
    });
    await closeTab("u1", "T0");
    const t = await defaultTab("u1");
    expect(t.id).toBe("T9");
    expect(getWarmSession("u1")!.defaultTabId).toBe("T9");
    expect(getWarmSession("u1")!.cdpPageWsUrl).toBe("ws://127.0.0.1:9999/devtools/page/T9");
    expect(sent.map((x) => x.method)).toContain("Target.getTargets");
  });

  it("listTabs joins Target.getTargets with the map", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", {
      "Target.getTargets": { targetInfos: [
        { targetId: "T0", type: "page", url: "https://example.com", title: "Ex" },
        { targetId: "POP", type: "page", url: "https://example.com/pop", title: "Pop" },
        { targetId: "SW", type: "service_worker", url: "x", title: "" },
      ] },
    });
    expect(await listTabs("u1")).toEqual([
      { id: "T0", url: "https://example.com", title: "Ex", active: true },
      { id: "POP", url: "https://example.com/pop", title: "Pop", active: false },
    ]);
  });

  it("touchTab bumps the tab and the session", async () => {
    const s = await ensureSession("u1");
    s.lastActivity = 0;
    s.tabs.get("T0")!.lastActivity = 0;
    touchTab("u1", "T0");
    expect(s.tabs.get("T0")!.lastActivity).toBeGreaterThan(0);
    expect(s.lastActivity).toBeGreaterThan(0);
  });

  it("closeBrowserSession closes every tab client", async () => {
    await ensureSession("u1");
    await stubBrowserTarget("u1", { "Target.createTarget": { targetId: "T1" } });
    const r = await openTab("u1");
    if (!r.ok) throw new Error("open failed");
    const spy = vi.spyOn(r.tab.cdp, "close");
    await closeBrowserSession("u1");
    expect(spy).toHaveBeenCalled();
    expect(getWarmSession("u1")).toBeUndefined();
  });
});
