import { describe, it, expect, beforeEach } from "vitest";
import { takeToken, _setNowForTest, _resetRateLimitForTest } from "../../src/spaces/rate-limit";

describe("spaces/rate-limit", () => {
  let t = 0;
  beforeEach(() => {
    t = 0;
    _setNowForTest(() => t);
    _resetRateLimitForTest();
  });

  it("allows 60 per minute per (viewer, Space), then reports when to retry", () => {
    for (let i = 0; i < 60; i++) expect(takeToken("v", "s").ok).toBe(true);
    const over = takeToken("v", "s");
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.retryAfterMs).toBe(1000);
    expect(takeToken("v", "other").ok).toBe(true);
    expect(takeToken("w", "s").ok).toBe(true);
    t += 1000;
    expect(takeToken("v", "s").ok).toBe(true);
    expect(takeToken("v", "s").ok).toBe(false);
  });
});
