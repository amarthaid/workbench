import { describe, it, expect, beforeEach } from "vitest";
import {
  markConnectStarted, markConnectEnded, isConnectInProgress, CONNECT_LOCK_TTL_MS,
} from "../src/auth/reconnect/connect-lock";

const U = "user-connect-lock";

describe("connect lock", () => {
  beforeEach(() => markConnectEnded(U));

  it("is not in progress by default", () => {
    expect(isConnectInProgress(U)).toBe(false);
  });

  it("start sets it, end clears it", () => {
    markConnectStarted(U);
    expect(isConnectInProgress(U)).toBe(true);
    markConnectEnded(U);
    expect(isConnectInProgress(U)).toBe(false);
  });

  it("is per user", () => {
    markConnectStarted(U);
    expect(isConnectInProgress("user-other")).toBe(false);
  });

  it("expires after the 10-minute TTL and the expired entry is dropped", () => {
    expect(CONNECT_LOCK_TTL_MS).toBe(600_000);
    const t0 = 1_000_000;
    markConnectStarted(U, t0);
    expect(isConnectInProgress(U, t0 + CONNECT_LOCK_TTL_MS - 1)).toBe(true);
    expect(isConnectInProgress(U, t0 + CONNECT_LOCK_TTL_MS)).toBe(false);
    // Deleted on read: an earlier clock no longer revives it.
    expect(isConnectInProgress(U, t0)).toBe(false);
  });

  it("restarting refreshes the TTL", () => {
    const t0 = 1_000_000;
    markConnectStarted(U, t0);
    markConnectStarted(U, t0 + 500_000);
    expect(isConnectInProgress(U, t0 + CONNECT_LOCK_TTL_MS + 1)).toBe(true);
  });
});
