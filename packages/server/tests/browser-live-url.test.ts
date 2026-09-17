import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureMock, signMock } = vi.hoisted(() => ({
  ensureMock: vi.fn(),
  signMock: vi.fn(),
}));

vi.mock("../src/auth/browser-session", () => ({
  ensureSession: ensureMock,
  touch: vi.fn(),
  navigate: vi.fn(), screenshot: vi.fn(), click: vi.fn(),
  typeText: vi.fn(), pressKey: vi.fn(), scroll: vi.fn(), readText: vi.fn(),
  closeBrowserSession: vi.fn(),
}));
vi.mock("../src/auth/connect-token", () => ({
  signConnectToken: signMock,
}));

const { createPendingMock } = vi.hoisted(() => ({
  createPendingMock: vi.fn(),
}));

vi.mock("../src/auth/connections", () => ({
  createPending: createPendingMock,
}));

import { browserPlugin } from "../src/plugins/internal/browser";

beforeEach(() => {
  vi.clearAllMocks();
  ensureMock.mockResolvedValue({ userId: "u1", cdpToken: "ctok" });
  signMock.mockResolvedValue("jwt-xyz");
  createPendingMock.mockReturnValue({ connectionId: "conn-1", status: "PENDING" });
});

describe("browser_live_url", () => {
  it("mints a connect JWT for the pending record and returns a /browser URL", async () => {
    const t = browserPlugin.tools.find((m) => m.name === "browser_live_url")!;
    const out = (await (t.handler as any)({ userId: "u1" }, {})) as { url: string };
    expect(createPendingMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", integration: "__browser__", type: "cookie" })
    );
    expect(signMock).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        userId: "u1",
        sessionId: "u1",
        integration: "__browser__",
      }),
      expect.any(Number)
    );
    expect(out.url).toContain("/browser?t=jwt-xyz");
  });

  it("mints a link without warming a session or embedding a cdpToken", async () => {
    const { ensureSession } = await import("../src/auth/browser-session");
    const actualToken = await vi.importActual<typeof import("../src/auth/connect-token")>(
      "../src/auth/connect-token"
    );
    signMock.mockImplementation(actualToken.signConnectToken);

    const t = browserPlugin.tools.find((m) => m.name === "browser_live_url")!;
    const out = (await (t.handler as any)({ userId: "user-1" }, {})) as { url: string };

    expect(out.url).toMatch(/\/browser\?t=/);
    expect(ensureSession).not.toHaveBeenCalled();
    const jwt = new URL(out.url).searchParams.get("t")!;
    const payload = await actualToken.verifyConnectToken(jwt);
    expect(payload.userId).toBe("user-1");
    expect(payload.integration).toBe("__browser__");
  });
});
