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
  evaluate: evalMock,
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
  verifySessionKey: vi.fn((key: string | undefined, _userId: string) => key === "test-session-id"),
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
    const out = await (tool("browser_navigate").handler as any)({ userId: "u1" }, { session_id: "test-session-id", url: "https://e.com" });
    expect(ensureMock).toHaveBeenCalledWith("u1");
    expect(touchMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ url: "https://e.com", title: "E" });
  });

  it("requires session_id on every tool except browser_start, so each call can be routed", () => {
    // A tool without the key lands on a random replica behind a load
    // balancer: ensureSession there spawns a second chromium on the shared
    // profile, and await_download looks up a handle that lives in another
    // process. The three file-transfer tools were missing it.
    for (const t of browserPlugin.tools) {
      if (t.name === "browser_start") continue;
      const shape = (t.inputSchema as any).shape;
      expect(shape, t.name).toHaveProperty("session_id");
      expect(shape.session_id.isOptional(), t.name).toBe(false);
    }
  });

  it("refuses a session_id that is not this user's routing key before touching the session", async () => {
    const out = await (tool("browser_navigate").handler as any)(
      { userId: "u1" },
      { session_id: "someone-elses-or-garbage", url: "https://e.com" }
    );
    expect(out).toMatchObject({ error: "BAD_SESSION_KEY" });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(navMock).not.toHaveBeenCalled();
  });

  it("browser_evaluate runs the expression on the session and returns the helper result", async () => {
    evalMock.mockResolvedValue({ value: 3 });
    const out = await (tool("browser_evaluate").handler as any)(
      { userId: "u1" },
      { session_id: "test-session-id", expression: "1+2" }
    );
    expect(ensureMock).toHaveBeenCalledWith("u1");
    expect(touchMock).toHaveBeenCalledWith("u1");
    expect(evalMock).toHaveBeenCalledWith({ userId: "u1" }, "1+2", expect.objectContaining({ awaitPromise: true }));
    expect(out).toEqual({ value: 3 });
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
    const out = await (tool("browser_screenshot").handler as any)({ userId: "u1" }, { session_id: "test-session-id", maxWidth: 800 });
    expect(shotMock).toHaveBeenCalledWith({ userId: "u1" }, { session_id: "test-session-id", maxWidth: 800 });
    expect(out).toEqual({ _mcpImage: { data: "B64", mimeType: "image/jpeg" } });
  });

  it("browser_click returns ok", async () => {
    const out = await (tool("browser_click").handler as any)({ userId: "u1" }, { session_id: "test-session-id", x: 1, y: 2, button: "left" });
    expect(clickMock).toHaveBeenCalledWith({ userId: "u1" }, 1, 2, "left");
    expect(out).toEqual({ ok: true });
  });

  it("browser_close closes the session", async () => {
    const out = await (tool("browser_close").handler as any)({ userId: "u1" }, { session_id: "test-session-id" });
    expect(closeMock).toHaveBeenCalledWith("u1");
    expect(out).toEqual({ ok: true });
  });

  it("browser_read_text returns the text result", async () => {
    readMock.mockResolvedValue({ text: "page text", truncated: false });
    const out = await (tool("browser_read_text").handler as any)({ userId: "u1" }, { session_id: "test-session-id", maxChars: 500 });
    expect(readMock).toHaveBeenCalledWith({ userId: "u1" }, 500);
    expect(out).toEqual({ text: "page text", truncated: false });
  });
});
