// Presentation helpers for timestamps the API reports in Unix seconds. `now`
// is injectable so the tests do not depend on when they run.

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isoDate(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function dayLabel(unixSeconds: number, now: Date = new Date()): string {
  const then = new Date(unixSeconds * 1000);
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(then)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return isoDate(then);
}

export function timeLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

export function durationLabel(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function relativeTime(unixSeconds: number, now: Date = new Date()): string {
  if (!unixSeconds) return "—";
  const seconds = now.getTime() / 1000 - unixSeconds;
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
