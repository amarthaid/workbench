import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const KEY = "abcd1234abcd1234";

const { cfg, spawnMock, pmMock, pulseFns } = vi.hoisted(() => {
  const pmMock = {
    epoch: 3,
    createDevices: vi.fn(async (k: string) => ({ sink: `wb_sink_${k}`, mic: `wb_mic_${k}`, source: `wb_src_${k}` })),
    clientEnv: vi.fn(() => ({ PULSE_SERVER: "unix:/tmp/wb-pulse-test/native" })),
  };
  return {
    cfg: { BROWSER_AUDIO_ENABLED: true, BROWSER_TAB_LIMIT: 8, BROWSER_SESSION_TTL_SECONDS: 300 },
    spawnMock: vi.fn(),
    pmMock,
    pulseFns: { pulseFor: vi.fn(() => pmMock), releasePulse: vi.fn(async () => undefined) },
  };
});

vi.mock("../src/config", () => ({ config: cfg }));
vi.mock("../src/auth/profile-chromium", () => ({
  spawnProfileChromium: spawnMock,
  activeProfiles: new Set<string>(),
  userProfileDir: (u: string) => `/tmp/profiles/${u}`,
  cdpCall: vi.fn(),
}));
vi.mock("../src/audio/pulse", () => ({
  deviceKey: () => KEY,
  pulseFor: pulseFns.pulseFor,
  releasePulse: pulseFns.releasePulse,
}));
vi.mock("../src/auth/profile-disk", () => ({ trimProfileCaches: vi.fn(async () => 0) }));
vi.mock("../src/auth/browser-downloads", () => ({ cancelDownloads: vi.fn(), configureDownloads: vi.fn(async () => undefined) }));
vi.mock("../src/auth/cookie", () => ({ startProxyAuth: vi.fn(), filterCookies: vi.fn() }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWs extends EventEmitter {
    send = vi.fn();
    close = vi.fn();
    constructor() { super(); setImmediate(() => this.emit("open")); }
  }
  return { default: FakeWs, WebSocket: FakeWs };
});

import { ensureSession, closeTab, browserEvents, getWarmSession, closeBrowserSession } from "../src/auth/browser-session";

let proc: any;
beforeEach(() => {
  vi.clearAllMocks();
  proc = new EventEmitter();
  proc.kill = vi.fn();
  spawnMock.mockResolvedValue({
    proc,
    remotePort: 9222,
    cdpBrowserWsUrl: "ws://127.0.0.1:9222/devtools/browser/x",
    cdpPageWsUrl: "ws://127.0.0.1:9222/devtools/page/T0",
    cdpPageTargetId: "T0",
    timings: {},
  });
  cfg.BROWSER_AUDIO_ENABLED = true;
});

describe("chromium spawn with audio", () => {
  it("creates devices first and passes PULSE_SINK/PULSE_SOURCE + autoplay flag", async () => {
    const s = await ensureSession("user-1");
    expect(pmMock.createDevices).toHaveBeenCalledWith(KEY);
    const [, opts] = spawnMock.mock.calls.at(-1);
    expect(opts.env.PULSE_SINK).toBe(`wb_sink_${KEY}`);
    expect(opts.env.PULSE_SOURCE).toBe(`wb_src_${KEY}`);
    expect(opts.env.PULSE_SERVER).toBe("unix:/tmp/wb-pulse-test/native");
    expect(opts.extraArgs).toContain("--autoplay-policy=no-user-gesture-required");
    expect(s.audio).toEqual({
      key: KEY,
      pm: pmMock,
      devices: { sink: `wb_sink_${KEY}`, mic: `wb_mic_${KEY}`, source: `wb_src_${KEY}` },
      epoch: 3,
    });
    await closeBrowserSession("user-1");
  });

  it("spawns without audio when the flag is off", async () => {
    cfg.BROWSER_AUDIO_ENABLED = false;
    const s = await ensureSession("user-2");
    const [, opts] = spawnMock.mock.calls.at(-1);
    expect(opts.env).toBeUndefined();
    expect(s.audio).toBeUndefined();
    expect(pulseFns.pulseFor).not.toHaveBeenCalled();
    await closeBrowserSession("user-2");
  });

  it("still opens the browser and releases the daemon when device creation fails", async () => {
    pmMock.createDevices.mockRejectedValueOnce(new Error("pulseaudio did not start"));
    const s = await ensureSession("user-3");
    expect(s.audio).toBeUndefined();
    expect(pulseFns.releasePulse).toHaveBeenCalledWith(KEY, pmMock);
    const [, opts] = spawnMock.mock.calls.at(-1);
    expect(opts.env).toBeUndefined();
    await closeBrowserSession("user-3");
  });

  it("releases the daemon and emits session-exit when chromium exits", async () => {
    await ensureSession("user-4");
    const exited = vi.fn();
    browserEvents.on("session-exit", exited);
    proc.emit("exit", 0, null);
    expect(exited).toHaveBeenCalledWith("user-4");
    expect(pulseFns.releasePulse).toHaveBeenCalledWith(KEY, pmMock);
    expect(getWarmSession("user-4")).toBeUndefined();
    browserEvents.off("session-exit", exited);
  });

  it("releases the daemon when spawn throws after audio was set up", async () => {
    spawnMock.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(ensureSession("user-6")).rejects.toThrow("spawn failed");
    expect(pulseFns.releasePulse).toHaveBeenCalledWith(KEY, pmMock);
  });

  it("emits tab-closed from closeTab", async () => {
    await ensureSession("user-5");
    const closed = vi.fn();
    browserEvents.on("tab-closed", closed);
    // Not awaited: closeTab then waits on Target.closeTarget, which the fake
    // socket never answers. The event fires synchronously before that await.
    void closeTab("user-5", "T0");
    expect(closed).toHaveBeenCalledWith("user-5", "T0");
    browserEvents.off("tab-closed", closed);
    await closeBrowserSession("user-5");
  });

  it("a stale exit handler releases only its own manager after a re-spawn", async () => {
    const oldProc = proc;
    await ensureSession("user-7");
    await closeBrowserSession("user-7");
    expect(pulseFns.releasePulse).toHaveBeenCalledWith(KEY, pmMock);
    // Re-spawn gets a fresh manager and a fresh process.
    const pm2 = { ...pmMock, createDevices: vi.fn(async (k: string) => ({ sink: `s${k}`, mic: `m${k}`, source: `r${k}` })) };
    pulseFns.pulseFor.mockReturnValueOnce(pm2 as any);
    const proc2: any = new EventEmitter();
    proc2.kill = vi.fn();
    spawnMock.mockResolvedValueOnce({
      proc: proc2, remotePort: 9223,
      cdpBrowserWsUrl: "ws://127.0.0.1:9223/devtools/browser/y",
      cdpPageWsUrl: "ws://127.0.0.1:9223/devtools/page/T1",
      cdpPageTargetId: "T1", timings: {},
    });
    const s2 = await ensureSession("user-7");
    expect(s2.audio?.pm).toBe(pm2);
    pulseFns.releasePulse.mockClear();
    oldProc.emit("exit", 0, null);
    expect(pulseFns.releasePulse).toHaveBeenCalledTimes(1);
    expect(pulseFns.releasePulse).toHaveBeenCalledWith(KEY, pmMock);
    expect(pulseFns.releasePulse).not.toHaveBeenCalledWith(KEY, pm2);
    await closeBrowserSession("user-7");
  });

  it("a throwing session-exit listener does not skip teardown", async () => {
    await ensureSession("user-8");
    const boom = () => { throw new Error("listener boom"); };
    browserEvents.on("session-exit", boom);
    await expect(closeBrowserSession("user-8")).resolves.toBeUndefined();
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    browserEvents.off("session-exit", boom);
  });

  it("a throwing tab-closed listener does not skip Target.closeTarget", async () => {
    const s = await ensureSession("user-9");
    const sends: string[] = [];
    s.browserCdp = { send: vi.fn(async (m: string) => { sends.push(m); return {}; }), close: vi.fn() } as any;
    const boom = () => { throw new Error("listener boom"); };
    browserEvents.on("tab-closed", boom);
    await closeTab("user-9", "T0");
    expect(sends).toContain("Target.closeTarget");
    browserEvents.off("tab-closed", boom);
    await closeBrowserSession("user-9");
  });
});
