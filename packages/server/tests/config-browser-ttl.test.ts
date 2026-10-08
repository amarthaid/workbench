import { describe, it, expect } from "vitest";
import { config } from "../src/config";

describe("config BROWSER_SESSION_TTL_SECONDS", () => {
  it("defaults to 300 seconds", () => {
    expect(config.BROWSER_SESSION_TTL_SECONDS).toBe(300);
  });
  it("is a positive integer", () => {
    expect(Number.isInteger(config.BROWSER_SESSION_TTL_SECONDS)).toBe(true);
    expect(config.BROWSER_SESSION_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe("config BROWSER_AUDIO_MAX_MINUTES", () => {
  it("caps at 1440 so the max-duration setTimeout cannot overflow", async () => {
    const { configSchema } = await import("../src/config");
    expect(configSchema.shape.BROWSER_AUDIO_MAX_MINUTES.safeParse("1440").success).toBe(true);
    expect(configSchema.shape.BROWSER_AUDIO_MAX_MINUTES.safeParse("1441").success).toBe(false);
    expect(configSchema.shape.BROWSER_AUDIO_MAX_MINUTES.safeParse("0").success).toBe(false);
  });
});
