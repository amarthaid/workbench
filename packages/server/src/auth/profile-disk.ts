import { config } from "../config";
import { activeProfiles, profilesBaseDir, profileDirName } from "./profile-chromium";
import { join } from "node:path";
import {
  reapProfiles,
  type ProfileReapResult,
} from "../reap/profiles";

// The sweep itself now lives in ../reap/profiles.ts, a leaf module with no
// imports beyond node builtins — so the `reap` subcommand can run it without
// dragging in Playwright (via profile-chromium) or config.ts (and with it
// ENCRYPTION_KEY). This file is the in-process face of it: config defaults, and
// the activeProfiles set that only exists in the server process.
//
// There is deliberately NO startProfileDiskReaper here any more. It ran on
// every pod, so under HA N processes swept the same shared PVC concurrently.
// Sweeping is a scheduled job now: `npm run reap`.
export {
  THROWAWAY_PATHS,
  USE_MARKERS,
  LIVE_WINDOW_MS,
  trimProfileCaches,
  listProfileDirs,
  profileLastUsed,
  duBytes,
} from "../reap/profiles";

export type ReapResult = ProfileReapResult;

/**
 * In-process profile sweep, with this process's live sessions excluded by name
 * as well as by use-marker age.
 *
 * Kept for tests and for any caller inside the server; the scheduled job calls
 * `reapProfiles` directly with no active set, relying on marker staleness.
 */
export async function reapProfileDisk(
  opts: { now?: number; baseDir?: string; ttlDays?: number; liveWindowMs?: number } = {}
): Promise<ReapResult> {
  const base = opts.baseDir ?? profilesBaseDir();
  return reapProfiles({
    baseDir: base,
    ttlDays: opts.ttlDays ?? config.BROWSER_PROFILE_TTL_DAYS,
    now: opts.now,
    liveWindowMs: opts.liveWindowMs,
    activeDirs: [...activeProfiles].map((userId) => join(base, profileDirName(userId))),
  });
}
