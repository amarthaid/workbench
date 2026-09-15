import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureMock, touchMock, navMock, shotMock, clickMock, typeMock, keyMock, scrollMock, readMock, closeMock } =
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
    closeMock: vi.fn(),
  }));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: ensureMock,
  touch: touchMock,
  navigate: navMock,
  screenshot: shotMock,
  click: clickMock,
  typeText: typeMock,
  pressKey: keyMock,
  scroll: scrollMock,
  readText: readMock,
  closeBrowserSession: closeMock,
  browserClient: vi.fn(),
  ensureDownloadRouting: vi.fn(),
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
  SESSION_HEADER: "x-browser-session",
}));

import { browserPlugin } from "../src/plugins/internal/browser";

function tool(name: string) {
  const t = browserPlugin.tools.find((m) => m.name === name);
  if (!t) throw new Error(`missing ${name}`);
  return t;
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureMock.mockResolvedValue({ userId: "u1" });
});

describe("browser plugin tools", () => {
  it("browser_navigate ensures session, touches, navigates", async () => {
    navMock.mockResolvedValue({ url: "https://e.com", title: "E" });
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { url: "https://e.com" });
    expect(ensureMock).toHaveBeenCalledWith("u1");
    expect(touchMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ url: "https://e.com", title: "E" });
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
    const out = await (tool("browser_screenshot").handler as any)({ userId: "u1" }, { maxWidth: 800 });
    expect(shotMock).toHaveBeenCalledWith({ userId: "u1" }, { maxWidth: 800 });
    expect(out).toEqual({ _mcpImage: { data: "B64", mimeType: "image/jpeg" } });
  });

  it("browser_click returns ok", async () => {
    const out = await (tool("browser_click").handler as any)({ userId: "u1" }, { x: 1, y: 2, button: "left" });
    expect(clickMock).toHaveBeenCalledWith({ userId: "u1" }, 1, 2, "left");
    expect(out).toEqual({ ok: true });
  });

  it("browser_close closes the session", async () => {
    const out = await (tool("browser_close").handler as any)({ userId: "u1" }, {});
    expect(closeMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ ok: true });
  });

  it("browser_read_text returns the text result", async () => {
    readMock.mockResolvedValue({ text: "page text", truncated: false });
    const out = await (tool("browser_read_text").handler as any)({ userId: "u1" }, { maxChars: 500 });
    expect(readMock).toHaveBeenCalledWith({ userId: "u1" }, 500);
    expect(out).toEqual({ text: "page text", truncated: false });
  });
});
