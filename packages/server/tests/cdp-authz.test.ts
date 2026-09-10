import { describe, it, expect, vi, beforeEach } from "vitest";

const { getWarmCdpEndpointMock, verifyConnectTokenMock } = vi.hoisted(() => ({
  getWarmCdpEndpointMock: vi.fn(),
  verifyConnectTokenMock: vi.fn(),
}));

vi.mock("../src/auth/browser-session", () => ({
  getWarmCdpEndpoint: getWarmCdpEndpointMock,
}));

vi.mock("../src/auth/connect-token", () => ({
  verifyConnectToken: verifyConnectTokenMock,
}));

import { authorizeCdpAttach } from "../src/auth/cdp-authz";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/page/ABC";

beforeEach(() => {
  getWarmCdpEndpointMock.mockReset();
  verifyConnectTokenMock.mockReset();
});

describe("authorizeCdpAttach", () => {
  it("returns the warm endpoint when portal user matches the sessionId", async () => {
    getWarmCdpEndpointMock.mockReturnValue(ENDPOINT);
    const result = await authorizeCdpAttach(
      { sessionId: "user-1", cdpToken: "tok-1" },
      "user-1"
    );
    expect(result).toBe(ENDPOINT);
    expect(getWarmCdpEndpointMock).toHaveBeenCalledWith("user-1", "tok-1");
    // A matching portal user never needs the connect-JWT branch.
    expect(verifyConnectTokenMock).not.toHaveBeenCalled();
  });

  it("returns null when portal user does not match the sessionId", async () => {
    getWarmCdpEndpointMock.mockReturnValue(ENDPOINT);
    const result = await authorizeCdpAttach(
      { sessionId: "user-2", cdpToken: "tok-1" },
      "user-1"
    );
    expect(result).toBeNull();
    expect(getWarmCdpEndpointMock).not.toHaveBeenCalled();
  });

  it("rejects a frame whose only credential is a connect JWT", async () => {
    const result = await authorizeCdpAttach(
      { sessionId: "user-1", cdpToken: "tok-1", bearer: "jwt" } as never,
      null
    );
    expect(result).toBeNull();
    expect(verifyConnectTokenMock).not.toHaveBeenCalled();
    expect(getWarmCdpEndpointMock).not.toHaveBeenCalled();
  });

  it("returns null when authorized but no warm session exists", async () => {
    getWarmCdpEndpointMock.mockReturnValue(null);
    const result = await authorizeCdpAttach(
      { sessionId: "user-1", cdpToken: "tok-1" },
      "user-1"
    );
    expect(result).toBeNull();
    expect(getWarmCdpEndpointMock).toHaveBeenCalledWith("user-1", "tok-1");
  });

  it("returns null when there is neither a portal user nor a bearer", async () => {
    const result = await authorizeCdpAttach(
      { sessionId: "user-1", cdpToken: "tok-1" },
      null
    );
    expect(result).toBeNull();
    expect(verifyConnectTokenMock).not.toHaveBeenCalled();
  });
});
