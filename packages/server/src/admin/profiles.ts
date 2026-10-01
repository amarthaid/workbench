import { basename } from "node:path";
import { duBytes, listProfileDirs, profileLastUsed, LIVE_WINDOW_MS } from "../reap/profiles";

export interface ProfileInfo {
  name: string;
  email: string | null;
  bytes: number;
  /** Unix seconds, or null when no marker or directory time is available. */
  last_used: number | null;
  live: boolean;
}

/**
 * One row per profile directory under `baseDir`. Pure over its inputs so it can
 * be tested against a temp dir; the route supplies the live values. "Live" uses
 * the same rule as the reaper: this process holds it, or a use-marker moved
 * inside LIVE_WINDOW_MS.
 */
export async function listBrowserProfiles(o: {
  baseDir: string;
  activeDirs: Iterable<string>;
  emailByDirName: Map<string, string | null>;
  now?: number;
}): Promise<ProfileInfo[]> {
  const now = o.now ?? Date.now();
  const active = new Set(o.activeDirs);
  const out: ProfileInfo[] = [];

  for (const dir of await listProfileDirs(o.baseDir)) {
    const name = basename(dir);
    const lastUsedMs = await profileLastUsed(dir);
    out.push({
      name,
      email: o.emailByDirName.get(name) ?? null,
      bytes: await duBytes(dir),
      last_used: lastUsedMs > 0 ? Math.floor(lastUsedMs / 1000) : null,
      live: active.has(dir) || now - lastUsedMs < LIVE_WINDOW_MS,
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}
