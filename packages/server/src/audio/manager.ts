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
      error: "AUDIO_DISABLED" | "BROWSER_TAB_NOT_FOUND" | "AUDIO_BUSY" | "BROWSER_RESTART_REQUIRED";
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

async function setMic(userId: string, origin: string, setting: "granted" | "prompt"): Promise<void> {
  const s = getWarmSession(userId);
  if (!s) return;
  const browser = await browserClient(s);
  await browser.send("Browser.setPermission", { permission: { name: "microphone" }, setting, origin });
}

async function tabUrl(userId: string, tabId: string): Promise<string> {
  const s = getWarmSession(userId);
  if (!s) return "";
  const browser = await browserClient(s);
  const r = (await browser.send("Target.getTargetInfo", { targetId: tabId })) as { targetInfo?: { url?: string } };
  return r.targetInfo?.url ?? "";
}

export async function startAudio(
  userId: string,
  tabId: string,
  rate: number,
  opts: { restart?: boolean } = {}
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
      detail: "audio is already running in another tab; call browser_audio_stop on it first",
      session_id: existing.tabId,
    };
  }
  if (!getTab(userId, tabId)) {
    return { ok: false, error: "BROWSER_TAB_NOT_FOUND", detail: "session_id is not an open tab of yours" };
  }

  // A dead daemon is restarted here, which bumps its epoch, which makes the
  // check below catch a chromium still wired to the old one.
  let warm = getWarmSession(userId);
  if (warm?.audio) await warm.audio.pm.ensureDaemon();
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
    const url = await tabUrl(userId, tabId).catch(() => "");
    await closeBrowserSession(userId);
    const opened = await openTab(userId);
    if (!opened.ok) throw new Error(`browser restart failed: ${opened.error}`);
    if (originOf(url)) await navigate(opened.tab, url);
    tabId = opened.tab.id;
    restarted = true;
    warm = getWarmSession(userId);
    if (!warm?.audio) throw new Error("browser restarted without audio devices; check the server log for the PulseAudio error");
  }

  const audio = warm.audio;
  const tab = getTab(userId, tabId) as Tab;
  const granted = new Set<string>();
  const grant = (origin: string | null) => {
    if (!origin || granted.has(origin)) return;
    granted.add(origin);
    void setMic(userId, origin, "granted").catch(() => undefined);
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
      for (const origin of granted) void setMic(userId, origin, "prompt").catch(() => undefined);
    },
  });

  // Meeting pages hop origins on join (a landing page, then the web client),
  // so the grant follows every main-frame navigation, not just the first page.
  const offNav = tab.cdp.on("Page.frameNavigated", (p) => {
    const frame = (p as { frame?: { parentId?: string; url?: string } }).frame;
    if (frame && !frame.parentId && frame.url) grant(originOf(frame.url));
  });
  const keepAlive = setInterval(() => touchTab(userId, tabId), KEEPALIVE_MS);
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
