import { describe, it, expect, afterEach } from "vitest";
import { config } from "../src/config";
import { pickDebugPort } from "../src/auth/profile-chromium";

// A chromium on an allow-listed loopback port would be reachable from agent
// tabs, so the debug port is never one of BROWSER_LOOPBACK_ALLOW_PORTS.
describe("pickDebugPort", () => {
  const saved = config.BROWSER_LOOPBACK_ALLOW_PORTS;
  afterEach(() => { config.BROWSER_LOOPBACK_ALLOW_PORTS = saved; });

  it("retries while the free port is allow-listed", async () => {
    config.BROWSER_LOOPBACK_ALLOW_PORTS = [8080, 8081];
    const offered = [8080, 8081, 8080, 41000];
    expect(await pickDebugPort(async () => offered.shift()!)).toBe(41000);
  });

  it("gives up rather than return an allow-listed port", async () => {
    config.BROWSER_LOOPBACK_ALLOW_PORTS = [8080];
    await expect(pickDebugPort(async () => 8080)).rejects.toThrow(/allow-listed/);
  });

  it("returns a real free port by default", async () => {
    config.BROWSER_LOOPBACK_ALLOW_PORTS = [];
    const p = await pickDebugPort();
    expect(p).toBeGreaterThan(0);
  });
});
