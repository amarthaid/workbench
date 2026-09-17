import { chromium } from "playwright";
import { spawn, ChildProcess } from "node:child_process";
import { mkdirSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createServer } from "node:net";
import WebSocket from "ws";
import { config } from "../config";

// Userdata dirs can't be shared by two Chromium processes — one active session
// (capture OR warm browser) per user at a time. Shared by cookie.ts and
// browser-session.ts so the two are mutually exclusive.
export const activeProfiles = new Set<string>();

export function profilesBaseDir(): string {
  return config.BROWSER_PROFILES_DIR || join(dirname(config.DATABASE_URL), "browser-profiles");
}

// A userId is not a safe path segment on its own — sanitize before it ever
// becomes one (see the path-traversal test).
export function profileDirName(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function userProfileDir(userId: string): string {
  return join(profilesBaseDir(), profileDirName(userId));
}

// Chromium writes SingletonLock/Socket/Cookie into the profile to stop two
// processes sharing one user-data-dir. The lock is a symlink encoding
// "<hostname>-<pid>". On a persistent/shared volume (e.g. a k8s PVC) a pod that
// dies uncleanly — OOM, SIGKILL, a rolling deploy — leaves these behind. The
// next pod sees a lock naming a host that no longer exists and refuses to start
// ("profile appears to be in use by another Chromium process … on another
// computer"), exiting code 21 before DevTools ever comes up.
//
// We already serialize same-process sessions via activeProfiles, so any lock we
// find here is stale by definition: no live session we know of owns it. Clear
// it so chromium can recreate its own. rmSync swallows ENOENT, so a clean
// profile is a no-op.
export function clearStaleSingletonLocks(userDataDir: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(userDataDir, name), { force: true });
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || !addr) {
        srv.close();
        reject(new Error("getFreePort: no address"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

export interface PollOpts {
  /** Give up this long after the first attempt. Budget in time, not attempts:
   *  an attempt count silently shrinks the budget when each fetch is slow. */
  deadlineMs: number;
  intervalMs?: number;
  /** Called before each attempt; a returned Error ends the poll with it. */
  abort?: () => Error | null;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export async function pollJson(url: string, opts: PollOpts): Promise<unknown> {
  const intervalMs = opts.intervalMs ?? 100;
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + opts.deadlineMs;
  let lastErr: unknown = null;
  for (;;) {
    const stop = opts.abort?.();
    if (stop) throw stop;
    try {
      const res = await doFetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Failed to reach ${url}: ${String(lastErr)}`);
}

interface TargetInfo {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}
interface VersionInfo {
  webSocketDebuggerUrl: string;
}

// One-shot CDP request/response over a fresh socket.
export async function cdpCall(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, origin: "http://127.0.0.1" });
    const timeout = setTimeout(() => {
      try { ws.close(); } catch { /* noop */ }
      reject(new Error(`cdpCall ${method} timed out`));
    }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) reject(new Error(`cdp ${method}: ${msg.error.message}`));
          else resolve(msg.result ?? {});
        }
      } catch (e) {
        clearTimeout(timeout);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

export interface SpawnStageTimings {
  /** free-port lookup + mkdir + stale-lock clear, before exec */
  prepareMs: number;
  /** exec → DevTools /json/version answers. Dominated by chromium's own startup. */
  devtoolsMs: number;
  /** DevTools up → a usable page target exists */
  targetMs: number;
  totalMs: number;
}

export interface SpawnedChromium {
  proc: ChildProcess;
  remotePort: number;
  cdpBrowserWsUrl: string;
  cdpPageWsUrl: string;
  /** targetId of the page chromium opened at spawn; the session's default tab. */
  cdpPageTargetId: string;
  timings: SpawnStageTimings;
}

// Launch a headless Chromium on the user's persistent profile and resolve once
// its DevTools endpoint and a non-blank page target are up. Caller owns the
// activeProfiles lock (acquire before calling, release on failure/teardown).
export async function spawnProfileChromium(
  userId: string,
  opts: { startUrl?: string } = {}
): Promise<SpawnedChromium> {
  const t0 = Date.now();
  const remotePort = await getFreePort();
  const userDataDir = userProfileDir(userId);
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  chmodSync(userDataDir, 0o700);
  clearStaleSingletonLocks(userDataDir);
  const execPath = chromium.executablePath();
  const args = [
    "--headless=new",
    `--remote-debugging-port=${remotePort}`,
    `--user-data-dir=${userDataDir}`,
    "--remote-allow-origins=http://127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=TranslateUI",
    "--window-size=1280,800",
    // Disk discipline. These profiles are persistent and per-user, so anything
    // chromium downloads into one is paid for 1× per user, forever. A headless
    // driving session needs none of it:
    //   background networking — pulls the Safe Browsing blocklist (tens of MB
    //     per profile) plus component/field-trial updates. Nobody is being
    //     protected from phishing here; the operator drives the browser.
    //   component update / phishing detection / sync — same class, no consumer.
    //   disk-cache-size — caps the HTTP cache, which otherwise grows to
    //     hundreds of MB per profile and is regenerable by definition.
    // See docs/findings/2026-08-06-browser-profile-disk-growth.md.
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-client-side-phishing-detection",
    "--disable-sync",
    "--disable-breakpad",
    `--disk-cache-size=${config.BROWSER_DISK_CACHE_MB * 1024 * 1024}`,
    ...(process.env.CAPTURE_PROXY ? [`--proxy-server=${process.env.CAPTURE_PROXY}`] : []),
    "--no-sandbox",
    "--disable-dev-shm-usage",
  ];
  if (opts.startUrl) args.push(opts.startUrl);
  // Capture stderr so a launch failure (missing lib, crashed renderer, unwritable
  // profile dir, OOM) surfaces as a real reason instead of an opaque CDP timeout.
  const tSpawn = Date.now();
  const proc = spawn(execPath, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });

  let stderrTail = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let spawnErr: Error | null = null;
  proc.on("error", (e) => { spawnErr = e; });
  proc.on("exit", (code, signal) => { exit = { code, signal }; });

  // If chromium died before/while we poll, fail fast with the captured reason
  // rather than burning the full poll budget on a process that's already gone.
  const launchFailure = (): Error | null => {
    if (spawnErr) return new Error(`chromium failed to spawn (${execPath}): ${spawnErr.message}`);
    if (exit) {
      const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`;
      return new Error(`chromium exited (${how}) before DevTools came up. stderr: ${stderrTail.trim() || "(empty)"}`);
    }
    return null;
  };

  try {
    const versionUrl = `http://127.0.0.1:${remotePort}/json/version`;
    await pollJson(versionUrl, { deadlineMs: config.BROWSER_LAUNCH_TIMEOUT_MS, abort: launchFailure });
    const versionInfo = (await pollJson(versionUrl, { deadlineMs: 2_000 })) as VersionInfo;
    const tDevtools = Date.now();
    let target: TargetInfo | undefined;
    for (let i = 0; i < 30; i++) {
      const targets = (await pollJson(`http://127.0.0.1:${remotePort}/json`, { deadlineMs: 2_000 })) as TargetInfo[];
      target = targets.find((t) => t.type === "page");
      if (target && target.url && (opts.startUrl ? target.url !== "about:blank" : true)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!target) throw new Error("CDP: no page target found");

    // Per-stage timings, not one opaque total: "connect is slow" is unactionable,
    // "devtoolsMs is 9s and targetMs is 200ms" points straight at chromium
    // startup rather than at our polling or the page load.
    const tDone = Date.now();
    const timings: SpawnStageTimings = {
      prepareMs: tSpawn - t0,
      devtoolsMs: tDevtools - tSpawn,
      targetMs: tDone - tDevtools,
      totalMs: tDone - t0,
    };
    console.log(
      `[chromium-spawn] prepare=${timings.prepareMs}ms devtools=${timings.devtoolsMs}ms ` +
        `target=${timings.targetMs}ms total=${timings.totalMs}ms`
    );

    return {
      proc,
      remotePort,
      cdpBrowserWsUrl: versionInfo.webSocketDebuggerUrl,
      cdpPageWsUrl: target.webSocketDebuggerUrl,
      cdpPageTargetId: target.id,
      timings,
    };
  } catch (e) {
    // Don't leak a half-alive chromium when startup fails. Prefer the concrete
    // launch failure (exit code + stderr) over the generic poll-timeout error.
    try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    throw launchFailure() ?? e;
  }
}
