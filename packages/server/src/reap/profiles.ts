import { rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Browser-profile disk sweep. Deliberately a LEAF module: it imports nothing
// but node builtins.
//
// It used to live in auth/profile-disk.ts, which imports auth/profile-chromium,
// whose first line is `import { chromium } from "playwright"` — so anything
// touching the sweep dragged Playwright in. That is an absurd dependency for a
// job whose whole purpose is deleting directories, and it would also have
// forced config.ts (and with it ENCRYPTION_KEY) into the reaper CronJob.

// Persistent per-user profiles keep the user logged in, but the session state
// that earns that persistence (Cookies, Local Storage, IndexedDB, History) is a
// few MB. The rest is regenerable: HTTP cache, compiled-script cache, GPU/shader
// caches, and the Safe Browsing blocklist — the last of which is an identical
// multi-MB download in every profile and useless to a headless browser that
// nobody is protecting from phishing.
//
// Deleting these logs nobody out. Chromium recreates whatever it needs on the
// next launch.
export const THROWAWAY_PATHS = [
  // profile root
  "Safe Browsing",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "component_crx_cache",
  "extensions_crx_cache",
  "Crashpad",
  "optimization_guide_model_store",
  // per-profile directory
  "Default/Cache",
  "Default/Code Cache",
  "Default/GPUCache",
  "Default/DawnCache",
  "Default/DawnGraphiteCache",
  "Default/DawnWebGPUCache",
  "Default/Application Cache",
];

// Files chromium rewrites whenever a profile is actually used. The profile
// directory's own mtime is not usable for staleness: trimming caches mutates it,
// which would keep every profile looking freshly used forever.
export const USE_MARKERS = ["Default/Cookies", "Default/Preferences"];

/**
 * How recently a use-marker must have moved for a profile to count as live.
 *
 * This is the out-of-process substitute for the `activeProfiles` Set. That Set
 * is module-level state in the server process, and a separate reaper process
 * cannot be handed it — but the filesystem already answers the question, since
 * a live session rewrites Cookies and Preferences continuously.
 *
 * BROWSER_SESSION_TTL_SECONDS is 300, so an hour is a 12x margin.
 *
 * Files need no equivalent: their retention is age only, so an in-flight
 * download has an mtime of now and is never a candidate. Profiles do need it,
 * because trimming the caches of a *running* chromium is not the same as
 * deleting a stale tree.
 */
export const LIVE_WINDOW_MS = 3_600_000;

export async function duBytes(path: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    // Not a directory (or gone) — fall back to a plain stat.
    try {
      const s = await stat(path);
      return s.isFile() ? s.size : 0;
    } catch {
      return 0;
    }
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) total += await duBytes(p);
    else if (e.isFile()) {
      try { total += (await stat(p)).size; } catch { /* raced with chromium */ }
    }
  }
  return total;
}

/**
 * Delete the regenerable parts of one profile. Best-effort: a path that is
 * missing, or that chromium recreates mid-sweep, is not an error.
 */
export async function trimProfileCaches(profileDir: string): Promise<number> {
  let freed = 0;
  for (const rel of THROWAWAY_PATHS) {
    const target = join(profileDir, rel);
    const size = await duBytes(target);
    if (size === 0) continue;
    try {
      await rm(target, { recursive: true, force: true });
      freed += size;
    } catch { /* in use or already gone */ }
  }
  return freed;
}

export async function listProfileDirs(base: string): Promise<string[]> {
  try {
    const entries = await readdir(base, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(base, e.name));
  } catch {
    return [];
  }
}

export async function profileLastUsed(profileDir: string): Promise<number> {
  let newest = 0;
  for (const rel of USE_MARKERS) {
    try { newest = Math.max(newest, (await stat(join(profileDir, rel))).mtimeMs); }
    catch { /* marker absent */ }
  }
  if (newest > 0) return newest;
  try { return (await stat(profileDir)).mtimeMs; } catch { return 0; }
}

export interface ProfileReapResult {
  trimmed: number;
  freedBytes: number;
  deleted: string[];
  skippedActive: number;
}

export interface ProfileReapOptions {
  baseDir: string;
  ttlDays: number;
  now?: number;
  dryRun?: boolean;
  /**
   * Profile directories known to be in use by THIS process. Empty out of
   * process, where `liveWindowMs` does the work instead.
   */
  activeDirs?: Iterable<string>;
  liveWindowMs?: number;
}

/**
 * Sweep the profile base: trim regenerable caches everywhere, and delete whole
 * profiles nobody has used inside the TTL.
 *
 * A profile is skipped when this process knows it is active, or when a
 * use-marker moved inside `liveWindowMs` — chromium holds its user-data-dir
 * open, and trimming underneath a live browser is not something to do on a
 * guess.
 */
export async function reapProfiles(opts: ProfileReapOptions): Promise<ProfileReapResult> {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlDays * 86_400_000;
  const liveWindowMs = opts.liveWindowMs ?? LIVE_WINDOW_MS;
  const active = new Set(opts.activeDirs ?? []);
  const result: ProfileReapResult = { trimmed: 0, freedBytes: 0, deleted: [], skippedActive: 0 };

  for (const dir of await listProfileDirs(opts.baseDir)) {
    const lastUsed = await profileLastUsed(dir);
    if (active.has(dir) || now - lastUsed < liveWindowMs) {
      result.skippedActive++;
      continue;
    }

    if (ttlMs > 0 && now - lastUsed > ttlMs) {
      const size = await duBytes(dir);
      if (opts.dryRun) {
        result.deleted.push(dir);
        result.freedBytes += size;
        continue;
      }
      try {
        await rm(dir, { recursive: true, force: true });
        result.deleted.push(dir);
        result.freedBytes += size;
        continue;
      } catch { /* fall through to a trim */ }
    }

    if (opts.dryRun) {
      let wouldFree = 0;
      for (const rel of THROWAWAY_PATHS) wouldFree += await duBytes(join(dir, rel));
      if (wouldFree > 0) { result.trimmed++; result.freedBytes += wouldFree; }
      continue;
    }
    const freed = await trimProfileCaches(dir);
    if (freed > 0) { result.trimmed++; result.freedBytes += freed; }
  }
  return result;
}
