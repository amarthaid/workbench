// A human is mid-way through a manual cookie connect (portal live view or a
// connect link). Auto-reconnect must not drive the same chromium underneath
// them. `activeProfiles` cannot answer this: a warm browser holds it for its
// whole life, so gating on it made every reconnect BUSY.
//
// Process-local like the browser it guards (the connect routes and the runner
// both run on the process that owns the user's chromium). The TTL bounds a
// connect that was abandoned without capture or cancel.

export const CONNECT_LOCK_TTL_MS = 600_000;

const inProgress = new Map<string, number>(); // userId -> expiresAt (epoch ms)

export function markConnectStarted(userId: string, now = Date.now()): void {
  inProgress.set(userId, now + CONNECT_LOCK_TTL_MS);
}

export function markConnectEnded(userId: string): void {
  inProgress.delete(userId);
}

export function isConnectInProgress(userId: string, now = Date.now()): boolean {
  const expiresAt = inProgress.get(userId);
  if (expiresAt === undefined) return false;
  if (now >= expiresAt) {
    inProgress.delete(userId);
    return false;
  }
  return true;
}
