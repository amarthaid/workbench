import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const cfg = vi.hoisted(() => ({ BROWSER_AUDIO_ENABLED: true, BROWSER_AUDIO_MAX_MINUTES: 120 }));
const warm = new Map<string, any>();
const tabs = new Map<string, any>();

vi.mock("../src/config", () => ({ config: cfg }));
// Factories import EventEmitter themselves: vi.hoisted runs before imports and
// `require` does not exist in an ESM test file.
vi.mock("../src/auth/browser-session", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    browserEvents: new EventEmitter(),
    getWarmSession: vi.fn(),
    getTab: vi.fn(),
    touchTab: vi.fn(),
    browserClient: vi.fn(),
    closeBrowserSession: vi.fn(async () => undefined),
    openTab: vi.fn(),
    navigate: vi.fn(async () => ({})),
  };
});

import { startAudio, stopAudio, getAudio, initBrowserAudio, KEEPALIVE_MS } from "../src/audio/manager";
import * as bsModule from "../src/auth/browser-session";

const bs = bsModule as any;

function fakeProc() {
  const p = new EventEmitter() as any;
  p.stdout = new PassThrough();
  p.stdin = new PassThrough();
  p.kill = vi.fn(() => true);
  return p;
}

function fakeTab(id: string) {
  const cdp = new EventEmitter() as any;
  cdp.send = vi.fn();
  cdp.on = vi.fn((m: string, fn: any) => { EventEmitter.prototype.on.call(cdp, m, fn); return () => cdp.removeListener(m, fn); });
  return { id, cdp };
}

let browser: { send: ReturnType<typeof vi.fn> };
let fakePm: any;

function warmWith(audio: any) {
  return { userId: "user-1", audio };
}
function freshAudio() {
  return { key: "abcd1234abcd1234", pm: fakePm, devices: { sink: "s", mic: "m", source: "src" }, epoch: 1 };
}

beforeEach(() => {
  vi.useFakeTimers();
  cfg.BROWSER_AUDIO_ENABLED = true;
  fakePm = Object.assign(new EventEmitter(), {
    epoch: 1,
    ensureDaemon: vi.fn(async () => undefined),
    capture: vi.fn(() => fakeProc()),
    playback: vi.fn(() => fakeProc()),
  });
  warm.clear();
  tabs.clear();
  warm.set("user-1", warmWith(freshAudio()));
  tabs.set("T1", fakeTab("T1"));
  tabs.set("T2", fakeTab("T2"));
  bs.getWarmSession.mockImplementation((u: string) => warm.get(u));
  bs.getTab.mockImplementation((_u: string, id: string) => tabs.get(id));
  browser = { send: vi.fn(async (method: string) => method === "Target.getTargetInfo"
    ? { targetInfo: { url: "https://meet.example.com/abc-defg" } }
    : {}) };
  bs.browserClient.mockResolvedValue(browser);
  bs.touchTab.mockClear();
  bs.closeBrowserSession.mockReset();
  bs.closeBrowserSession.mockResolvedValue(undefined);
  bs.openTab.mockReset();
  bs.navigate.mockClear();
  initBrowserAudio();
});

afterEach(() => {
  for (const u of ["user-1"]) { const s = getAudio(u); if (s) stopAudio(u, s.tabId); }
  vi.useRealTimers();
});

describe("startAudio", () => {
  it("binds the tab, starts the session, grants the mic to the tab's origin", async () => {
    const r = await startAudio("user-1", "T1", 24000);
    expect(r).toMatchObject({ ok: true, session_id: "T1", restarted: false });
    expect(getAudio("user-1")?.tabId).toBe("T1");
    expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: "https://meet.example.com",
    });
  });

  it("is refused when the flag is off", async () => {
    cfg.BROWSER_AUDIO_ENABLED = false;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "AUDIO_DISABLED" });
  });

  it("refuses an unknown tab", async () => {
    expect(await startAudio("user-1", "nope", 24000)).toMatchObject({ ok: false, error: "BROWSER_TAB_NOT_FOUND" });
  });

  it("refuses a second tab while one is bound, naming the bound tab", async () => {
    await startAudio("user-1", "T1", 24000);
    expect(await startAudio("user-1", "T2", 24000)).toMatchObject({ ok: false, error: "AUDIO_BUSY", session_id: "T1" });
  });

  it("says which rate is running when the same tab is asked for another", async () => {
    await startAudio("user-1", "T1", 24000);
    const r = (await startAudio("user-1", "T1", 16000)) as any;
    expect(r).toMatchObject({ ok: false, error: "AUDIO_BUSY", session_id: "T1" });
    expect(r.detail).toBe("audio is already running on session_id T1 at 24000 Hz; call browser_audio_stop first");
  });

  it("keeps the other-tab wording for a different tab", async () => {
    await startAudio("user-1", "T1", 24000);
    const r = (await startAudio("user-1", "T2", 24000)) as any;
    expect(r.detail).toBe("audio is already running in another tab; call browser_audio_stop on it first");
  });

  it("returns the existing session for the same tab and rate", async () => {
    const a = await startAudio("user-1", "T1", 24000);
    const b = await startAudio("user-1", "T1", 24000);
    expect((b as any).session).toBe((a as any).session);
  });

  it("restarts a dead daemon before checking the epoch", async () => {
    await startAudio("user-1", "T1", 24000);
    expect(fakePm.ensureDaemon).toHaveBeenCalled();
  });

  it("asks for a restart when chromium has no devices or an old epoch", async () => {
    warm.get("user-1").audio.epoch = 0;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "BROWSER_RESTART_REQUIRED" });
    warm.get("user-1").audio = undefined;
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "BROWSER_RESTART_REQUIRED" });
  });

  it("with restart: true restarts chromium, reopens the url in a new tab, binds that tab", async () => {
    warm.get("user-1").audio = undefined;
    const fresh = fakeTab("T9");
    bs.closeBrowserSession.mockImplementation(async () => { warm.set("user-1", warmWith(freshAudio())); });
    bs.openTab.mockImplementation(async () => { tabs.set("T9", fresh); return { ok: true, tab: fresh }; });
    const r = await startAudio("user-1", "T1", 24000, { restart: true });
    expect(bs.closeBrowserSession).toHaveBeenCalledWith("user-1");
    expect(bs.navigate).toHaveBeenCalledWith(fresh, "https://meet.example.com/abc-defg");
    expect(r).toMatchObject({ ok: true, session_id: "T9", restarted: true });
  });
});

describe("mic permission follows navigation", () => {
  it("re-grants on a main-frame navigation to a new origin, ignores subframes", async () => {
    await startAudio("user-1", "T1", 24000);
    browser.send.mockClear();
    const cdp = tabs.get("T1").cdp;
    cdp.emit("Page.frameNavigated", { frame: { id: "sub", parentId: "main", url: "https://ads.example.net/x" } });
    cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "https://app.example.com/wc/123" } });
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: "https://app.example.com",
    }));
    expect(browser.send).not.toHaveBeenCalledWith("Browser.setPermission", expect.objectContaining({ origin: "https://ads.example.net" }));
  });

  it("holds one granted origin at a time: revokes the previous before granting the next", async () => {
    await startAudio("user-1", "T1", 24000);
    const cdp = tabs.get("T1").cdp;
    cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "https://app.example.com/wc/123" } });
    cdp.emit("Page.frameNavigated", { frame: { id: "main", url: "https://evil.example.net/x" } });
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "granted", origin: "https://evil.example.net",
    }));
    const calls = browser.send.mock.calls.filter((c) => c[0] === "Browser.setPermission").map((c) => `${c[1].setting}:${c[1].origin}`);
    expect(calls).toEqual([
      "granted:https://meet.example.com",
      "prompt:https://meet.example.com",
      "granted:https://app.example.com",
      "prompt:https://app.example.com",
      "granted:https://evil.example.net",
    ]);
  });

  it("revokes the current origin when the session ends", async () => {
    await startAudio("user-1", "T1", 24000);
    stopAudio("user-1", "T1");
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith("Browser.setPermission", {
      permission: { name: "microphone" }, setting: "prompt", origin: "https://meet.example.com",
    }));
  });

  it("falls back to resetPermissions when a revoke fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await startAudio("user-1", "T1", 24000);
    browser.send.mockImplementation(async (m: string, p: any) => {
      if (m === "Browser.setPermission" && p.setting === "prompt") throw new Error("boom");
      return {};
    });
    stopAudio("user-1", "T1");
    await vi.waitFor(() => expect(browser.send).toHaveBeenCalledWith("Browser.resetPermissions", {}));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not grant after the session ended during the url lookup", async () => {
    let release!: () => void;
    browser.send.mockImplementation((m: string) => m === "Target.getTargetInfo"
      ? new Promise((r) => { release = () => r({ targetInfo: { url: "https://meet.example.com/x" } }); })
      : Promise.resolve({}));
    const p = startAudio("user-1", "T1", 24000);
    await vi.waitFor(() => expect(getAudio("user-1")).toBeDefined());
    stopAudio("user-1", "T1");
    release();
    await p;
    await vi.advanceTimersByTimeAsync(10);
    expect(browser.send).not.toHaveBeenCalledWith("Browser.setPermission", expect.objectContaining({ setting: "granted" }));
  });
});

describe("races and failures", () => {
  it("single-flights concurrent starts of the same tab", async () => {
    const [a, b] = await Promise.all([startAudio("user-1", "T1", 24000), startAudio("user-1", "T1", 24000)]);
    expect(a).toMatchObject({ ok: true });
    expect((b as any).session).toBe((a as any).session);
    expect(fakePm.capture).toHaveBeenCalledTimes(1);
  });

  it("concurrent starts of two tabs: one wins, the other is AUDIO_BUSY", async () => {
    const rs = await Promise.all([startAudio("user-1", "T1", 24000), startAudio("user-1", "T2", 24000)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ error: "AUDIO_BUSY", session_id: "T1" });
    expect(fakePm.capture).toHaveBeenCalledTimes(1);
  });

  it("a tab that vanishes while the daemon is checked is BROWSER_TAB_NOT_FOUND", async () => {
    fakePm.ensureDaemon.mockImplementation(async () => { tabs.delete("T1"); });
    expect(await startAudio("user-1", "T1", 24000)).toMatchObject({ ok: false, error: "BROWSER_TAB_NOT_FOUND" });
    expect(fakePm.capture).not.toHaveBeenCalled();
    expect(getAudio("user-1")).toBeUndefined();
  });

  it("a failed restart is BROWSER_RESTART_FAILED, not a throw", async () => {
    warm.get("user-1").audio = undefined;
    bs.openTab.mockResolvedValue({ ok: false, error: "nope" });
    expect(await startAudio("user-1", "T1", 24000, { restart: true })).toMatchObject({ ok: false, error: "BROWSER_RESTART_FAILED" });
  });

  it("a restart that still has a stale epoch is BROWSER_RESTART_FAILED", async () => {
    warm.get("user-1").audio = undefined;
    const fresh = fakeTab("T9");
    bs.closeBrowserSession.mockImplementation(async () => {
      warm.set("user-1", warmWith({ ...freshAudio(), epoch: 0 }));
    });
    bs.openTab.mockImplementation(async () => { tabs.set("T9", fresh); return { ok: true, tab: fresh }; });
    expect(await startAudio("user-1", "T1", 24000, { restart: true })).toMatchObject({ ok: false, error: "BROWSER_RESTART_FAILED" });
  });
});

describe("lifecycle", () => {
  it("keeps the tab alive only while a reader or an uplink is attached", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    vi.advanceTimersByTime(KEEPALIVE_MS * 3);
    expect(bs.touchTab).not.toHaveBeenCalled();
    const off = r.session.subscribe(() => undefined);
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(bs.touchTab).toHaveBeenCalledWith("user-1", "T1");
    bs.touchTab.mockClear();
    off();
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(bs.touchTab).not.toHaveBeenCalled();
    r.session.openUplink();
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(bs.touchTab).toHaveBeenCalledTimes(1);
  });

  it("stopAudio ends and reports; stop on an unbound tab returns zeros", async () => {
    await startAudio("user-1", "T1", 24000);
    expect(stopAudio("user-1", "T2")).toEqual({ played_ms: 0, duration_ms: 0 });
    const r = stopAudio("user-1", "T1");
    expect(r.played_ms).toBe(0);
    expect(getAudio("user-1")).toBeUndefined();
  });

  it("closing the bound tab ends with tab_closed; another tab does not", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    bs.browserEvents.emit("tab-closed", "user-1", "T2");
    expect(r.session.ended).toBeUndefined();
    bs.browserEvents.emit("tab-closed", "user-1", "T1");
    expect(r.session.ended).toBe("tab_closed");
    expect(getAudio("user-1")).toBeUndefined();
  });

  it("chromium exit ends with browser_exit", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    bs.browserEvents.emit("session-exit", "user-1");
    expect(r.session.ended).toBe("browser_exit");
  });

  it("daemon exit ends the session with audio_daemon_exit and unsubscribes", async () => {
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    expect(fakePm.listenerCount("daemon-exit")).toBe(1);
    fakePm.emit("daemon-exit");
    expect(r.session.ended).toBe("audio_daemon_exit");
    expect(fakePm.listenerCount("daemon-exit")).toBe(0);
  });

  it("initBrowserAudio is idempotent (one end per event)", async () => {
    initBrowserAudio();
    initBrowserAudio();
    const r = (await startAudio("user-1", "T1", 24000)) as any;
    const onEnd = vi.spyOn(r.session, "end");
    bs.browserEvents.emit("session-exit", "user-1");
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
