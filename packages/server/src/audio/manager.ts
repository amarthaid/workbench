// One audio session per user, bound to one tab. Owns everything that ties an
// AudioSession to the browser: which tab, the mic permission on that tab's
// origin(s), keeping the tab from idling out, and ending the session when the
// tab, the chromium, or the user's PulseAudio daemon goes away.
import { config } from "../config";
import { AudioSession } from "./session";
import {
  browserEvents,
  getWarmSession,
  getTab,
  touchTab,
  browserClient,
  closeBrowserSession,
  openTab,
  navigate,
  type Tab,
} from "../auth/browser-session";

export const KEEPALIVE_MS = 10_000;

export type StartAudioResult =
  | { ok: true; session: AudioSession; session_id: string; restarted: boolean }
  | {
      ok: false;
      error: "AUDIO_DISABLED" | "BROWSER_TAB_NOT_FOUND" | "AUDIO_BUSY" | "BROWSER_RESTART_REQUIRED" | "BROWSER_RESTART_FAILED";
      detail: string;
      session_id?: string;
    };

const sessions = new Map<string, AudioSession>();

export function getAudio(userId: string): AudioSession | undefined {
  return sessions.get(userId);
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function setMic(userId: string, origin: string, setting: "granted" | "prompt"): Promise<boolean> {
  try {
    const s = getWarmSession(userId);
    if (!s) return true; // no browser, nothing left to revoke
    const browser = await browserClient(s);
    await browser.send("Browser.setPermission", { permission: { name: "microphone" }, setting, origin });
    return true;
  } catch (e) {
    console.warn(`[audio] mic ${setting} failed for ${origin}:`, (e as Error).message);
    return false;
  }
}

/** A revoke that fails must not leave a standing grant: reset every permission the browser holds. */
async function revokeMic(userId: string, origin: string): Promise<void> {
  if (await setMic(userId, origin, "prompt")) return;
  try {
    const s = getWarmSession(userId);
    if (s) await (await browserClient(s)).send("Browser.resetPermissions", {});
  } catch (e) {
    console.warn(`[audio] resetPermissions failed after revoke of ${origin}:`, (e as Error).message);
  }
}

async function tabUrl(userId: string, tabId: string): Promise<string> {
  const s = getWarmSession(userId);
  if (!s) return "";
  const browser = await browserClient(s);
  const r = (await browser.send("Target.getTargetInfo", { targetId: tabId })) as { targetInfo?: { url?: string } };
  return r.targetInfo?.url ?? "";
}

const starting = new Map<string, Promise<StartAudioResult>>();

/** Single-flight per user: a concurrent call waits for the in-flight one, then re-evaluates against what it left. */
export async function startAudio(
  userId: string,
  tabId: string,
  rate: number,
  opts: { restart?: boolean } = {}
): Promise<StartAudioResult> {
  const inflight = starting.get(userId);
  if (inflight) {
    await inflight.catch(() => undefined);
    return startAudio(userId, tabId, rate, opts);
  }
  const p = doStart(userId, tabId, rate, opts).finally(() => starting.delete(userId));
  starting.set(userId, p);
  return p;
}

const tabGone = (): StartAudioResult => ({
  ok: false,
  error: "BROWSER_TAB_NOT_FOUND",
  detail: "session_id is not an open tab of yours",
});

async function doStart(
  userId: string,
  tabId: string,
  rate: number,
  opts: { restart?: boolean }
): Promise<StartAudioResult> {
  if (!config.BROWSER_AUDIO_ENABLED) {
    return { ok: false, error: "AUDIO_DISABLED", detail: "browser audio is off on this server (BROWSER_AUDIO_ENABLED)" };
  }
  const existing = sessions.get(userId);
  if (existing) {
    if (existing.tabId === tabId && existing.rate === rate) {
      return { ok: true, session: existing, session_id: tabId, restarted: false };
    }
    return {
      ok: false,
      error: "AUDIO_BUSY",
      detail:
        existing.tabId === tabId
          ? `audio is already running on session_id ${tabId} at ${existing.rate} Hz; call browser_audio_stop first`
          : "audio is already running in another tab; call browser_audio_stop on it first",
      session_id: existing.tabId,
    };
  }
  if (!getTab(userId, tabId)) return tabGone();

  // A dead daemon is restarted here, which bumps its epoch, which makes the
  // check below catch a chromium still wired to the old one.
  let warm = getWarmSession(userId);
  if (warm?.audio) await warm.audio.pm.ensureDaemon();
  warm = getWarmSession(userId);
  let restarted = false;
  if (!warm?.audio || warm.audio.epoch !== warm.audio.pm.epoch) {
    if (!opts.restart) {
      return {
        ok: false,
        error: "BROWSER_RESTART_REQUIRED",
        detail:
          "this browser was started without working audio devices. Call again with restart: true — the browser restarts, " +
          "logins survive, every open tab closes, and this tab's page reopens in a new tab whose session_id is returned",
      };
    }
    try {
      const url = await tabUrl(userId, tabId).catch(() => "");
      await closeBrowserSession(userId);
      const opened = await openTab(userId);
      if (!opened.ok) return { ok: false, error: "BROWSER_RESTART_FAILED", detail: `browser restart failed: ${opened.error}` };
      if (originOf(url)) await navigate(opened.tab, url);
      tabId = opened.tab.id;
    } catch (e) {
      return { ok: false, error: "BROWSER_RESTART_FAILED", detail: `browser restart failed: ${(e as Error).message}` };
    }
    restarted = true;
    warm = getWarmSession(userId);
    if (!warm?.audio || warm.audio.epoch !== warm.audio.pm.epoch) {
      return {
        ok: false,
        error: "BROWSER_RESTART_FAILED",
        detail: "browser restarted without working audio devices; check the server log for the PulseAudio error",
      };
    }
  }

  const tab = getTab(userId, tabId);
  if (!tab) return tabGone();
  const audio = warm.audio;

  // At most one origin holds the mic at a time. Operations are chained so a
  // revoke always lands before the next grant, and nothing is sent once the
  // session has ended (onEnd's revoke is the last link in the chain).
  let current: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const grant = (origin: string | null) => {
    if (!origin || session.ended || origin === current) return;
    const prev = current;
    current = origin;
    chain = chain.then(async () => {
      if (prev) await revokeMic(userId, prev);
      if (!session.ended) await setMic(userId, origin, "granted");
    });
  };

  const onDaemonExit = () => session.end("audio_daemon_exit");
  const session: AudioSession = new AudioSession({
    userId,
    tabId,
    rate,
    devices: audio.devices,
    io: audio.pm,
    maxMs: config.BROWSER_AUDIO_MAX_MINUTES * 60_000,
    onEnd: () => {
      if (sessions.get(userId) === session) sessions.delete(userId);
      clearInterval(keepAlive);
      offNav();
      audio.pm.off("daemon-exit", onDaemonExit);
      const last = current;
      if (last) chain = chain.then(() => revokeMic(userId, last));
    },
  });

  // Meeting pages hop origins on join (a landing page, then the web client),
  // so the grant follows every main-frame navigation, not just the first page.
  const offNav = tab.cdp.on("Page.frameNavigated", (p) => {
    const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
    if (frame && !frame.parentId && frame.url) grant(originOf(frame.url));
  });
  const keepAlive = setInterval(() => {
    if (session.attached) touchTab(userId, tabId);
  }, KEEPALIVE_MS);
  keepAlive.unref?.();
  audio.pm.on("daemon-exit", onDaemonExit);

  sessions.set(userId, session);
  session.start();
  grant(originOf(await tabUrl(userId, tabId).catch(() => "")));
  return { ok: true, session, session_id: tabId, restarted };
}

export function stopAudio(userId: string, tabId: string): { played_ms: number; duration_ms: number } {
  const s = sessions.get(userId);
  if (!s || s.tabId !== tabId) return { played_ms: 0, duration_ms: 0 };
  s.end("stopped");
  return { played_ms: s.totalPlayedMs, duration_ms: Date.now() - s.startedAt };
}

let initialized = false;

/** Wire the browser lifecycle events. Called once from index.ts when the feature is on. */
export function initBrowserAudio(): void {
  if (initialized) return;
  initialized = true;
  browserEvents.on("tab-closed", (userId: string, tabId: string) => {
    const s = sessions.get(userId);
    if (s?.tabId === tabId) s.end("tab_closed");
  });
  browserEvents.on("session-exit", (userId: string) => {
    sessions.get(userId)?.end("browser_exit");
  });
}
