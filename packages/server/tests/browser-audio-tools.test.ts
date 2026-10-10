import { describe, it, expect, vi, beforeEach } from "vitest";

const { startMock, stopMock, getTabMock, defaultTabMock, touchTabMock } = vi.hoisted(() => ({
  startMock: vi.fn(),
  stopMock: vi.fn(),
  getTabMock: vi.fn(),
  defaultTabMock: vi.fn(),
  touchTabMock: vi.fn(),
}));

vi.mock("../src/config", () => ({
  config: { SERVER_PUBLIC_URL: "https://wb.example.com", PORTAL_URL: "https://wb.example.com", CONNECT_TTL_SECONDS: 600 },
}));
vi.mock("../src/audio/manager", () => ({ startAudio: startMock, stopAudio: stopMock }));
vi.mock("../src/auth/browser-session", () => ({
  getTab: getTabMock,
  defaultTab: defaultTabMock,
  touchTab: touchTabMock,
  ensureSession: vi.fn(), touch: vi.fn(), openTab: vi.fn(), closeTab: vi.fn(), listTabs: vi.fn(),
  navigate: vi.fn(), screenshot: vi.fn(), click: vi.fn(), typeText: vi.fn(), pressKey: vi.fn(),
  scroll: vi.fn(), readText: vi.fn(), evaluate: vi.fn(), browserClient: vi.fn(), ensureDownloadRouting: vi.fn(),
}));
vi.mock("../src/auth/browser-downloads", () => ({ expectDownload: vi.fn(), awaitDownload: vi.fn() }));
vi.mock("../src/auth/browser-upload", () => ({ uploadWorkspaceFile: vi.fn(), BrowserUploadError: class extends Error {} }));
vi.mock("../src/auth/connect-token", () => ({ signConnectToken: vi.fn() }));
vi.mock("../src/auth/connections", () => ({ createPending: vi.fn() }));
vi.mock("../src/auth/cdp-bridge", () => ({
  mintSessionKey: vi.fn(() => "route-key"),
  verifySessionKey: vi.fn(() => false),
  SESSION_HEADER: "x-browser-session",
}));

import { browserPlugin } from "../src/plugins/internal/browser";

const tool = (n: string) => browserPlugin.tools.find((t) => t.name === n)! as any;
const TAB = { id: "T1", cdp: {} };
const live = (extra: Record<string, unknown> = {}) => ({ rate: 24000, whenEnded: new Promise(() => undefined), ...extra });
const CAP = /^https:\/\/wb\.example\.com\/api\/browser\/audio\/([A-Za-z0-9_-]{22})\/(stream|clear)$/;

beforeEach(() => {
  getTabMock.mockImplementation((_u: string, id: string) => (id === "T1" ? TAB : undefined));
});

describe("browser_audio_start", () => {
  it("defaults to 24 kHz and returns capability urls plus the routing header, nothing else", async () => {
    startMock.mockResolvedValue({ ok: true, session: live(), session_id: "T1", restarted: false });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(startMock).toHaveBeenCalledWith("user-1", "T1", 24000, { restart: false });
    // The shape is frozen: slaude's schema is strict and refuses unknown keys.
    expect(Object.keys(out).sort()).toEqual(
      ["channels", "clear_url", "format", "headers", "restarted", "sample_rate", "session_id", "stream_url"]
    );
    expect(out).toMatchObject({ session_id: "T1", restarted: false, format: "pcm_s16le", channels: 1, sample_rate: 24000 });
    expect(out.headers).toEqual({ "X-Browser-Session": "route-key" });
    const s = CAP.exec(out.stream_url);
    const c = CAP.exec(out.clear_url);
    expect(s?.[2]).toBe("stream");
    expect(c?.[2]).toBe("clear");
    expect(s?.[1]).toBe(c?.[1]);
    expect(out.stream_url).not.toContain("T1");
  });

  it("returns the same capability for a repeat start of the same session, a new one for a new session", async () => {
    const session = live();
    startMock.mockResolvedValue({ ok: true, session, session_id: "T1", restarted: false });
    const a = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    const b = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(b.stream_url).toBe(a.stream_url);
    startMock.mockResolvedValue({ ok: true, session: live(), session_id: "T1", restarted: false });
    const c = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(c.stream_url).not.toBe(a.stream_url);
  });

  it("only accepts 16000, 24000, 48000", () => {
    const schema = tool("browser_audio_start").inputSchema;
    expect(schema.safeParse({ session_id: "T1", sample_rate: 44100 }).success).toBe(false);
    expect(schema.safeParse({ session_id: "T1", sample_rate: 16000 }).success).toBe(true);
  });

  it("returns the tab-not-found error without calling the manager", async () => {
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "nope" });
    expect(out.error).toBe("BROWSER_TAB_NOT_FOUND");
    expect(startMock).not.toHaveBeenCalled();
  });

  it("passes manager refusals through", async () => {
    startMock.mockResolvedValue({ ok: false, error: "AUDIO_BUSY", detail: "busy", session_id: "T0" });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(out).toEqual({ error: "AUDIO_BUSY", detail: "busy", session_id: "T0" });
  });

  it("uses the new tab id in the urls after a restart", async () => {
    startMock.mockResolvedValue({ ok: true, session: live({ rate: 16000 }), session_id: "T9", restarted: true });
    const out = await tool("browser_audio_start").handler(
      { userId: "user-1" }, { session_id: "T1", sample_rate: 16000, restart: true }
    );
    expect(startMock).toHaveBeenCalledWith("user-1", "T1", 16000, { restart: true });
    expect(out.session_id).toBe("T9");
    expect(out.restarted).toBe(true);
    expect(out.stream_url).toMatch(CAP);
  });

  it("passes manager BROWSER_RESTART_FAILED error through", async () => {
    startMock.mockResolvedValue({ ok: false, error: "BROWSER_RESTART_FAILED", detail: "browser restart failed: error message" });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(out).toEqual({ error: "BROWSER_RESTART_FAILED", detail: "browser restart failed: error message" });
  });

  it("returns AUDIO_ENDED if session ended during start", async () => {
    startMock.mockResolvedValue({ ok: true, session: { rate: 24000, ended: "tab_closed" }, session_id: "T1", restarted: false });
    const out = await tool("browser_audio_start").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(out).toEqual({ error: "AUDIO_ENDED", detail: "audio ended during start: tab_closed" });
  });
});

describe("browser_audio_stop", () => {
  it("stops audio on the tab", async () => {
    stopMock.mockReturnValue({ played_ms: 1200, duration_ms: 60000 });
    const out = await tool("browser_audio_stop").handler({ userId: "user-1" }, { session_id: "T1" });
    expect(stopMock).toHaveBeenCalledWith("user-1", "T1");
    expect(out).toEqual({ played_ms: 1200, duration_ms: 60000 });
  });

  it("stops by raw id even when the tab is already gone", async () => {
    stopMock.mockReturnValue({ played_ms: 0, duration_ms: 0 });
    const out = await tool("browser_audio_stop").handler({ userId: "user-1" }, { session_id: "gone" });
    expect(stopMock).toHaveBeenCalledWith("user-1", "gone");
    expect(out).toEqual({ played_ms: 0, duration_ms: 0 });
  });
});
