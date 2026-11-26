// In-process token buckets for POST /api/spaces/:name/call: 60 calls per
// minute per (viewer, Space), and for a delegated Space also 300 per minute
// per (owner, Space), so many viewers together cannot exhaust the owner's
// upstream quota. Per process, so approximate under CLUSTER_ENABLED or several
// replicas.

export const RATE_CAPACITY = 60;
export const OWNER_RATE_CAPACITY = 300;
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

/** `capacity` per minute, refilled continuously. */
function take(key: string, capacity: number): RateResult {
  const refillPerMs = capacity / 60_000;
  const t = now();
  let b = buckets.get(key);
  if (!b) {
    // Bound memory: a full map is dropped wholesale, which only ever errs on
    // the side of letting calls through.
    if (buckets.size >= MAX_BUCKETS) buckets.clear();
    b = { tokens: capacity, at: t };
    buckets.set(key, b);
  } else {
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
  }
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterMs: Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs)) };
}

export function takeToken(userId: string, spaceName: string): RateResult {
  return take(`${userId}\u0000${spaceName}`, RATE_CAPACITY);
}

/** The owner's bucket for a delegated Space, keyed apart from every viewer's. */
export function takeOwnerToken(ownerId: string, spaceName: string): RateResult {
  return take(`owner\u0000${ownerId}\u0000${spaceName}`, OWNER_RATE_CAPACITY);
}
