// In-process token bucket for POST /api/spaces/:name/call: 60 calls per minute
// per (viewer, Space). Per process, so approximate under CLUSTER_ENABLED or
// several replicas.

export const RATE_CAPACITY = 60;
const REFILL_PER_MS = RATE_CAPACITY / 60_000;
const MAX_BUCKETS = 10_000;

interface Bucket {
  tokens: number;
  at: number;
}

const buckets = new Map<string, Bucket>();

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}
export function _resetRateLimitForTest(): void {
  buckets.clear();
}

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number };

export function takeToken(userId: string, spaceName: string): RateResult {
  const key = `${userId}\u0000${spaceName}`;
  const t = now();
  let b = buckets.get(key);
  if (!b) {
    // Bound memory: a full map is dropped wholesale, which only ever errs on
    // the side of letting calls through.
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    b = { tokens: RATE_CAPACITY, at: t };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(RATE_CAPACITY, b.tokens + (t - b.at) * REFILL_PER_MS);
    b.at = t;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil((1 - b.tokens) / REFILL_PER_MS)) };
}
