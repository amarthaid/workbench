// Recent-values scrub window: values the agent has echoed back to it via
// `{{vault:name}}` substitution in one call get scrubbed from that call's own
// result today (see interpolate.ts). But scrubbing is same-call-only: a value
// substituted in call N and echoed by an unrelated call N+1 (`browser_read_text`
// after a `browser_type`, `files_read` after a `files_write`, `browser_evaluate`
// reading an input's `.value`) comes back as plaintext, because call N+1 never
// referenced the secret and so never resolved it.
//
// The spec rejected scanning the whole vault against every result: that would
// decrypt every secret a user owns on every call, and a short value (a PIN, a
// port number) would collide with unrelated output regardless of whether the
// agent had ever touched it. This module is deliberately narrower: it only
// remembers values THIS process has already substituted for THIS user, for a
// short window, so a short value like "12" is scrubbed from unrelated output
// for that window, but only after the agent itself used it in this session,
// and only for a bounded time — not forever, and not for values it never saw.
//
// Module-level, in-process, in-memory — a scrub hint, not a credential store.
// Under CLUSTER_ENABLED the browser_* tools already route every request for a
// given user to one worker (docs/findings/2026-09-10-browser-session-pod-affinity.md),
// so the common case (login in one call, read in the next) stays on the same
// worker's ring. A result served by a different worker is only scrubbed
// against that worker's own ring — best-effort, like the encoding limits
// documented in interpolate.ts.

export const VAULT_RECENT_WINDOW_MS = 10 * 60_000;
export const VAULT_RECENT_MAX_PER_USER = 32;
// Safety net, not a hard cap: expiry already bounds memory over time, but
// without this a process that never restarts and sees a long tail of
// one-shot users (or the reaper's own 60s interval not having run yet) could
// carry an unbounded number of user entries, most of them already expired.
// Cheap because it only runs the same prune the reaper does, inline, and
// only once the map is already large enough to matter.
const MAX_RING_USERS_BEFORE_INLINE_PRUNE = 256;

interface Entry {
  name: string;
  value: string;
  at: number;
}

const ring = new Map<string, Entry[]>();

let now: () => number = () => Date.now();
export function _setNowForTest(fn: () => number): void {
  now = fn;
}

export function _resetForTest(): void {
  ring.clear();
  now = () => Date.now();
}

// Number of users currently holding at least one ring entry. Test seam only —
// production code has no legitimate reason to inspect ring size.
export function _sizeForTest(): number {
  return ring.size;
}

function isLive(e: Entry, t: number): boolean {
  return t - e.at < VAULT_RECENT_WINDOW_MS;
}

// Drop expired entries for every user, and the user entirely once nothing of
// theirs is left. This is the only thing that ever removes a user who stops
// making calls — `recentSubstituted` only prunes the user it was asked
// about, so an abandoned session's ring would otherwise sit in memory,
// plaintext, forever.
export function reapExpiredRecent(): void {
  const t = now();
  for (const [userId, entries] of ring) {
    const live = entries.filter((e) => isLive(e, t));
    if (live.length === 0) ring.delete(userId);
    else if (live.length !== entries.length) ring.set(userId, live);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startRecentReaper(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => reapExpiredRecent(), intervalMs);
  timer.unref?.();
}
export function stopRecentReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function rememberSubstituted(userId: string, substituted: Map<string, string>): void {
  if (substituted.size === 0) return;
  const t = now();
  const existing = (ring.get(userId) ?? []).filter((e) => isLive(e, t) && !substituted.has(e.name));
  const fresh: Entry[] = [...substituted].map(([name, value]) => ({ name, value, at: t }));
  const merged = [...existing, ...fresh];
  // Newest last above; keep the newest VAULT_RECENT_MAX_PER_USER entries.
  const trimmed = merged.slice(-VAULT_RECENT_MAX_PER_USER);
  ring.set(userId, trimmed);
  if (ring.size > MAX_RING_USERS_BEFORE_INLINE_PRUNE) reapExpiredRecent();
}

export function recentSubstituted(userId: string): Map<string, string> {
  const entries = ring.get(userId);
  if (!entries || entries.length === 0) return new Map();
  const t = now();
  const live = entries.filter((e) => isLive(e, t));
  if (live.length !== entries.length) {
    if (live.length === 0) ring.delete(userId);
    else ring.set(userId, live);
  }
  const out = new Map<string, string>();
  for (const e of live) out.set(e.name, e.value);
  return out;
}
