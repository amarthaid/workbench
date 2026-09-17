import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureMock, touchMock, navMock, shotMock, clickMock, typeMock, keyMock, scrollMock, readMock, evalMock, closeMock } =
  vi.hoisted(() => ({
    ensureMock: vi.fn(),
    touchMock: vi.fn(),
    navMock: vi.fn(),
    shotMock: vi.fn(),
    clickMock: vi.fn(),
    typeMock: vi.fn(),
    keyMock: vi.fn(),
    scrollMock: vi.fn(),
    readMock: vi.fn(),
    evalMock: vi.fn(),
    closeMock: vi.fn(),
  }));

const { openTabMock, getTabMock, defaultTabMock, closeTabMock, listTabsMock, touchTabMock, browserClientMock, ensureRoutingMock } =
  vi.hoisted(() => ({
    openTabMock: vi.fn(),
    getTabMock: vi.fn(),
    defaultTabMock: vi.fn(),
    closeTabMock: vi.fn(),
    listTabsMock: vi.fn(),
    touchTabMock: vi.fn(),
    browserClientMock: vi.fn(),
    ensureRoutingMock: vi.fn(),
  }));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: ensureMock,
  touch: touchMock,
  touchTab: touchTabMock,
  openTab: openTabMock,
  getTab: getTabMock,
  defaultTab: defaultTabMock,
  closeTab: closeTabMock,
  listTabs: listTabsMock,
  navigate: navMock,
  screenshot: shotMock,
  click: clickMock,
  typeText: typeMock,
  pressKey: keyMock,
  scroll: scrollMock,
  readText: readMock,
  evaluate: evalMock,
  closeBrowserSession: closeMock,
  browserClient: browserClientMock,
  ensureDownloadRouting: ensureRoutingMock,
}));

vi.mock("../src/auth/browser-downloads", () => ({
  expectDownload: vi.fn(),
  awaitDownload: vi.fn(),
}));

vi.mock("../src/auth/browser-upload", () => ({
  uploadWorkspaceFile: vi.fn(),
  BrowserUploadError: class BrowserUploadError extends Error {},
}));

vi.mock("../src/auth/cdp-bridge", () => ({
  mintSessionKey: vi.fn().mockReturnValue("test-session-id"),
  verifySessionKey: vi.fn((key: string | undefined, _userId: string) => key === "test-session-id"),
  SESSION_HEADER: "x-browser-session",
}));

import { browserPlugin } from "../src/plugins/internal/browser";
import { expectDownload } from "../src/auth/browser-downloads";

function tool(name: string) {
  const t = browserPlugin.tools.find((m) => m.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

let TAB: any;
let DEFAULT: any;

beforeEach(() => {
  vi.clearAllMocks();
  ensureMock.mockResolvedValue({ userId: "u1" });
  TAB = { id: "T1", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
  DEFAULT = { id: "T0", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
  getTabMock.mockImplementation((_u: string, id: string) => (id === "T1" ? TAB : undefined));
  defaultTabMock.mockResolvedValue(DEFAULT);
});

describe("browser plugin tools", () => {
  it("browser_start opens a tab and returns its id as session_id", async () => {
    openTabMock.mockResolvedValue({ ok: true, tab: TAB });
    const out = await (tool("browser_start").handler as any)({ userId: "u1" }, {});
    expect(openTabMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ session_id: "T1" });
  });

  it("browser_start surfaces the tab cap", async () => {
    openTabMock.mockResolvedValue({ ok: false, error: "BROWSER_TAB_LIMIT", limit: 8 });
    const out = await (tool("browser_start").handler as any)({ userId: "u1" }, {});
    expect(out).toEqual({ error: "BROWSER_TAB_LIMIT", limit: 8 });
  });

  it("browser_navigate resolves session_id to a tab, touches it, navigates that tab", async () => {
    navMock.mockResolvedValue({ url: "https://e.com", title: "E" });
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T1", url: "https://e.com" });
    expect(navMock).toHaveBeenCalledWith(TAB, "https://e.com");
    expect(touchTabMock).toHaveBeenCalledWith("u1", "T1");
    expect(out).toEqual({ url: "https://e.com", title: "E" });
  });

  it("an unknown session_id is BROWSER_TAB_NOT_FOUND and touches nothing", async () => {
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "garbage", url: "https://e.com" });
    expect(out).toMatchObject({ error: "BROWSER_TAB_NOT_FOUND" });
    expect(navMock).not.toHaveBeenCalled();
    expect(defaultTabMock).not.toHaveBeenCalled();
  });

  it("the pre-upgrade routing key still drives the default tab (compat)", async () => {
    navMock.mockResolvedValue({ url: "https://e.com", title: "E" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "test-session-id", url: "https://e.com" });
    expect(defaultTabMock).toHaveBeenCalledWith("u1");
    expect(navMock).toHaveBeenCalledWith(DEFAULT, "https://e.com");
  });

  it("two tabs are driven independently", async () => {
    const T2 = { id: "T2", cdp: { send: vi.fn() }, lastActivity: 0, createdAt: 0 };
    getTabMock.mockImplementation((_u: string, id: string) => ({ T1: TAB, T2 } as any)[id]);
    navMock.mockResolvedValue({ url: "x", title: "" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T1", url: "https://a.example.com" });
    await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "T2", url: "https://b.example.com" });
    expect(navMock).toHaveBeenNthCalledWith(1, TAB, "https://a.example.com");
    expect(navMock).toHaveBeenNthCalledWith(2, T2, "https://b.example.com");
  });

  it("browser_evaluate runs the expression on the tab", async () => {
    evalMock.mockResolvedValue({ value: 3 });
    const out = await (tool("browser_evaluate").handler as any)({ userId: "u1" }, { session_id: "T1", expression: "1+2" });
    expect(evalMock).toHaveBeenCalledWith(TAB, "1+2", expect.objectContaining({ awaitPromise: true }));
    expect(out).toEqual({ value: 3 });
  });

  it("browser_close closes the tab, not the session", async () => {
    closeTabMock.mockResolvedValue(true);
    const out = await (tool("browser_close").handler as any)({ userId: "u1" }, { session_id: "T1" });
    expect(closeTabMock).toHaveBeenCalledWith("u1", "T1");
    expect(closeMock).not.toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  it("browser_tabs lists the session's page targets", async () => {
    listTabsMock.mockResolvedValue([{ id: "T1", url: "https://e.com", title: "E", active: true }]);
    const out = await (tool("browser_tabs").handler as any)({ userId: "u1" }, {});
    expect(out).toEqual({ tabs: [{ session_id: "T1", url: "https://e.com", title: "E", active: true }] });
  });

  it("requires session_id on every driving tool, so each call names a tab", () => {
    // session_id names the tab to act on. A driving tool without it has no
    // target: it would have to guess between the tabs this user has open, and
    // two agents sharing the browser would step on each other. The tools that
    // take none are the ones that are about the browser, not about one tab.
    for (const t of browserPlugin.tools) {
      if (["browser_start", "browser_tabs", "browser_live_url"].includes(t.name)) continue;
      const shape = (t.inputSchema as any).shape;
      expect(shape, t.name).toHaveProperty("session_id");
      expect(shape.session_id.isOptional(), t.name).toBe(false);
    }
  });

  it("browser_navigate schema rejects non-http(s) protocols", () => {
    const schema = tool("browser_navigate").inputSchema;
    expect(() => schema.parse({ url: "file:///proc/self/environ" })).toThrow();
    expect(() => schema.parse({ url: "ftp://example.com" })).toThrow();
    expect(() => schema.parse({ url: "data:text/html,<script>" })).toThrow();
    expect(() => schema.parse({ url: "javascript:alert(1)" })).toThrow();
    expect(() => schema.parse({ session_id: "s", url: "http://example.com" })).not.toThrow();
    expect(() => schema.parse({ session_id: "s", url: "https://example.com" })).not.toThrow();
  });

  it("browser_screenshot forwards opts and returns the helper result", async () => {
    shotMock.mockResolvedValue({ _mcpImage: { data: "B64", mimeType: "image/jpeg" } });
    const out = await (tool("browser_screenshot").handler as any)({ userId: "u1" }, { session_id: "T1", maxWidth: 800 });
    expect(shotMock).toHaveBeenCalledWith(TAB, { session_id: "T1", maxWidth: 800 });
    expect(out).toEqual({ _mcpImage: { data: "B64", mimeType: "image/jpeg" } });
  });

  it("browser_click returns ok", async () => {
    const out = await (tool("browser_click").handler as any)({ userId: "u1" }, { session_id: "T1", x: 1, y: 2, button: "left" });
    expect(clickMock).toHaveBeenCalledWith(TAB, 1, 2, "left");
    expect(touchTabMock).toHaveBeenCalledWith("u1", "T1");
    expect(out).toEqual({ ok: true });
  });

  it("browser_read_text returns the text result", async () => {
    readMock.mockResolvedValue({ text: "page text", truncated: false });
    const out = await (tool("browser_read_text").handler as any)({ userId: "u1" }, { session_id: "T1", maxChars: 500 });
    expect(readMock).toHaveBeenCalledWith(TAB, 500);
    expect(out).toEqual({ text: "page text", truncated: false });
  });

  it("browser_expect_download arms on the browser-wide client after resolving the tab", async () => {
    const client = { id: "browser-client" };
    browserClientMock.mockResolvedValue(client);
    (expectDownload as any).mockReturnValue({ handle: "h1" });
    const out = await (tool("browser_expect_download").handler as any)({ userId: "u1" }, { session_id: "T1" });
    expect(ensureMock).toHaveBeenCalledWith("u1");
    expect(ensureRoutingMock).toHaveBeenCalledWith({ userId: "u1" });
    expect(browserClientMock).toHaveBeenCalledWith({ userId: "u1" });
    expect(out).toEqual({ handle: "h1" });
  });

  it("browser_expect_download refuses an unknown tab before warming anything", async () => {
    const out = await (tool("browser_expect_download").handler as any)({ userId: "u1" }, { session_id: "garbage" });
    expect(out).toMatchObject({ error: "BROWSER_TAB_NOT_FOUND" });
    expect(ensureMock).not.toHaveBeenCalled();
  });
});
