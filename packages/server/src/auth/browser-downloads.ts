import { randomBytes } from "node:crypto";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import { safeRelPath } from "../jots/paths";
import { ensureUserDir } from "../workspace/store";
import { userFilePath, userWorkspaceDir } from "../workspace/paths";
import type { CdpClient } from "./browser-session";

// Page downloads, captured into the user's file workspace.
//
// Deliberately imports no value from ./browser-session (only its CdpClient
// type, which erases at compile time), so the dependency runs one way:
// browser-session -> browser-downloads.

export interface CapturedDownload {
  name: string;
  bytes: number;
  expiresAt: string;
}

interface Pending {
  userId: string;
  /** Downloads seen since this handle was armed, by guid. */
  begun: Map<string, string>;
  resolve?: (d: CapturedDownload) => void;
  reject?: (e: Error) => void;
  settled: boolean;
  unsubscribe: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/**
 * Point a session's downloads at its owner's workspace.
 *
 * Called once when the session is created rather than lazily when a download is
 * armed: there is one chromium and one profile per user, so the directory is
 * known before any page opens and there is nothing to defer. The payoff is that
 * a download nobody armed a wait for still LANDS somewhere useful and shows up
 * in files_list, instead of vanishing into a temp directory.
 *
 * `allowAndName` — not `allow` — writes each file under its download GUID.
 * Collisions are the lesser reason. The real one is that `suggestedFilename`
 * comes from the remote server's Content-Disposition and is attacker
 * controlled; under `allow`, chromium derives the on-disk path from it. Under
 * `allowAndName` the path is a GUID we generated, and the suggested name is
 * just a string we sanitize on our own terms.
 */
export async function configureDownloads(userId: string, browser: CdpClient): Promise<void> {
  // chromium will not create a missing download directory.
  await ensureUserDir(userId);
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    downloadPath: userWorkspaceDir(userId),
    eventsEnabled: true,
  });
}

function sanitizeSuggested(suggested: unknown, guid: string): string {
  const base = typeof suggested === "string" ? path.basename(suggested) : "";
  // basename first, then the shared relative-path guard: a suggestedFilename of
  // "../../escape.csv" must never become a path.
  const safe = base && base !== "." && base !== ".." ? safeRelPath(base) : null;
  return safe ?? `download-${guid}`;
}

/** First free name of the form "base (2).ext" beside an existing "base.ext". */
async function uniqueName(userId: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    const abs = userFilePath(userId, candidate);
    if (!abs) return `download-${randomBytes(4).toString("hex")}${ext}`;
    try {
      await stat(abs);
    } catch {
      return candidate;
    }
  }
  return `download-${randomBytes(4).toString("hex")}${ext}`;
}

/**
 * Arm a download wait.
 *
 * A download is a side effect of a click, not a callable verb — the agent
 * cannot ask for a URL it does not know. So the sequence is arm, act, await.
 * Making every click implicitly wait would charge each one a timeout for a
 * download that usually is not coming.
 */
export function expectDownload(
  userId: string,
  browser: CdpClient,
  onProgress?: () => void
): { handle: string } {
  const handle = randomBytes(8).toString("hex");
  const state: Pending = {
    userId,
    begun: new Map(),
    settled: false,
    unsubscribe: () => undefined,
  };

  const offBegin = browser.on("Browser.downloadWillBegin", (p) => {
    const guid = typeof p.guid === "string" ? p.guid : null;
    if (!guid) return;
    state.begun.set(guid, sanitizeSuggested(p.suggestedFilename, guid));
  });

  const offProgress = browser.on("Browser.downloadProgress", (p) => {
    const guid = typeof p.guid === "string" ? p.guid : null;
    if (!guid || !state.begun.has(guid)) return;
    // Keep the session alive while bytes are still moving: reapIdleSessions
    // would otherwise close a session out from under a large transfer.
    onProgress?.();
    const st = p.state;
    if (st === "completed") void finish(handle, guid).catch(() => undefined);
    else if (st === "canceled") settle(handle, new Error("DOWNLOAD_CANCELED"));
  });

  state.unsubscribe = () => { offBegin(); offProgress(); };
  pending.set(handle, state);
  return { handle };
}

function settle(handle: string, err: Error): void {
  const state = pending.get(handle);
  if (!state || state.settled) return;
  state.settled = true;
  state.unsubscribe();
  if (state.timer) clearTimeout(state.timer);
  pending.delete(handle);
  state.reject?.(err);
}

async function finish(handle: string, guid: string): Promise<void> {
  const state = pending.get(handle);
  if (!state || state.settled) return;

  const dir = userWorkspaceDir(state.userId);
  const src = path.join(dir, guid);
  let bytes: number;
  try {
    bytes = (await stat(src)).size;
  } catch {
    return settle(handle, new Error("DOWNLOAD_MISSING"));
  }

  if (bytes > config.WORKSPACE_MAX_FILE_BYTES) {
    await rm(src, { force: true });
    return settle(handle, new Error("TOO_LARGE"));
  }

  const name = await uniqueName(state.userId, state.begun.get(guid) ?? `download-${guid}`);
  const dest = userFilePath(state.userId, name);
  if (!dest) return settle(handle, new Error("INVALID_NAME"));
  // Same directory, so the rename is atomic.
  await rename(src, dest);

  state.settled = true;
  state.unsubscribe();
  if (state.timer) clearTimeout(state.timer);
  pending.delete(handle);
  state.resolve?.({
    name,
    bytes,
    expiresAt: new Date(Date.now() + config.WORKSPACE_TTL_HOURS * 3_600_000).toISOString(),
  });
}

export function awaitDownload(handle: string, timeoutMs = 120_000): Promise<CapturedDownload> {
  const state = pending.get(handle);
  if (!state) return Promise.reject(new Error("UNKNOWN_HANDLE"));
  return new Promise<CapturedDownload>((resolve, reject) => {
    state.resolve = resolve;
    state.reject = reject;
    state.timer = setTimeout(() => settle(handle, new Error("DOWNLOAD_TIMEOUT")), timeoutMs);
  });
}

/** Drop every armed wait for a session that is going away. */
export function cancelDownloads(userId: string): void {
  for (const [handle, state] of pending) {
    if (state.userId === userId) settle(handle, new Error("SESSION_CLOSED"));
  }
}

export const _test = { pending, sanitizeSuggested, uniqueName };
