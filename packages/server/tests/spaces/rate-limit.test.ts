import { describe, it, expect, beforeEach } from "vitest";
import { takeToken, takeOwnerToken, OWNER_RATE_CAPACITY, _setNowForTest, _resetRateLimitForTest } from "../../src/spaces/rate-limit";

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

describe("spaces/rate-limit owner bucket", () => {
  let t = 0;
  beforeEach(() => {
    t = 0;
    _setNowForTest(() => t);
    _resetRateLimitForTest();
  });

  it("allows 300 per minute per (owner, Space), separate from the viewer buckets", () => {
    expect(OWNER_RATE_CAPACITY).toBe(300);
    for (let i = 0; i < 300; i++) expect(takeOwnerToken("o", "s").ok).toBe(true);
    const over = takeOwnerToken("o", "s");
    expect(over.ok).toBe(false);
    // 300 per 60 s refills one every 200 ms.
    if (!over.ok) expect(over.retryAfterMs).toBe(200);
    // Another Space of the same owner, and the same id as a viewer, are their own buckets.
    expect(takeOwnerToken("o", "other").ok).toBe(true);
    expect(takeToken("o", "s").ok).toBe(true);
    t += 200;
    expect(takeOwnerToken("o", "s").ok).toBe(true);
    expect(takeOwnerToken("o", "s").ok).toBe(false);
  });
});
