import type { CookieConfig, ReconnectStep } from "@a-workbench/shared";
import { registry } from "../../plugins/registry";
import { auditLogger } from "../../audit/logger";
import { readSecretValue, touchUsed } from "../../vault/store";
import { openTab, closeTab, getWarmSession, captureLiveCookies, pressKey, type PageHandle } from "../browser-session";
import { storeCookies, type CookieData } from "../cookie";
import { getReconnectState, updateReconnectState, type ReconnectState } from "./state";
import { clickSelector, fillSelector, waitForSelector, waitForUrl, currentUrl, StepError, type ReconnectReason } from "./dom";
import { mayOwnBrowser } from "./affinity";
import { isConnectInProgress } from "./connect-lock";

export const RECONNECT_COOLDOWN_MS = 600_000;
const DEFAULT_RUN_MS = 30_000;
const DEFAULT_STEP_MS = 10_000;
const CRED_RE = /\{\{cred:([a-z0-9_]+)\}\}/g;

export type ReconnectOutcome =
  | { ok: true }
  | { ok: false; reason: ReconnectReason | "COOLDOWN" | "BUSY" | "NOT_OWNER" | "NO_RECIPE"; step?: number };

type RecipeAuth = CookieConfig & Required<Pick<CookieConfig, "session" | "reconnect">>;

// Test seams: the liveness probe (the only network call the runner makes
// itself) and the settle time after a goto.
export const __deps = {
  async probe(url: string, cookieHeader: string): Promise<number> {
    const res = await fetch(url, { headers: { Cookie: cookieHeader }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.status;
  },
  GOTO_SETTLE_MS: 500,
};

/** False inside the cooldown that follows a failed attempt. */
export function canAttemptReconnect(state: ReconnectState, now = Date.now()): boolean {
  return !(state.last && !state.last.ok && now - state.last.at < RECONNECT_COOLDOWN_MS);
}

const locks = new Map<string, Promise<ReconnectOutcome>>();

export async function reconnectSession(userId: string, integration: string): Promise<ReconnectOutcome> {
  const auth = registry.getIntegration(integration)?.auth;
  if (!auth || auth.type !== "cookie" || !auth.reconnect || !auth.session) return { ok: false, reason: "NO_RECIPE" };
  if (!mayOwnBrowser()) {
    // Not our chromium to drive. Mark the session dead; record no attempt.
    await updateReconnectState(userId, integration, { deadAt: Date.now() });
    return { ok: false, reason: "NOT_OWNER" };
  }
  const key = `${userId}:${integration}`;
  let p = locks.get(key);
  if (!p) {
    p = attempt(userId, integration, auth as RecipeAuth);
    locks.set(key, p);
    // .finally() chains a second promise; swallow its rejection or a failed
    // run becomes an unhandled rejection.
    void p.finally(() => locks.delete(key)).catch(() => {});
  }
  return p;
}

function allowedHosts(auth: RecipeAuth): string[] {
  return [auth.targetDomain, ...(auth.cookieDomains ?? []), ...(auth.reconnect.allowHosts ?? [])]
    .map((d) => d.replace(/^\./, "").toLowerCase());
}

/**
 * `""`/`about:blank` pass only before the first goto: the fresh tab's blank
 * page. Afterwards an empty href means the evaluate failed, so fail closed.
 */
function hostOk(href: string, allowed: string[], navigated: boolean): boolean {
  if (!navigated && (href === "about:blank" || href === "")) return true;
  try {
    const h = new URL(href).hostname.toLowerCase();
    return allowed.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

/** Race `p` against the run deadline; expiry is StepError("TIMEOUT"). */
async function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    p.catch(() => {});
    throw new StepError("TIMEOUT");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepError("TIMEOUT")), remaining);
  });
  try {
    return await Promise.race([p, expiry]);
  } finally {
    clearTimeout(timer);
    // The loser keeps running until the tab closes; never let it reject unhandled.
    p.catch(() => {});
  }
}

function cookieHeaderFor(cookies: { name: string; value: string }[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function probeAlive(auth: RecipeAuth, cookies: { name: string; value: string }[]): Promise<boolean> {
  const probe = auth.session.probe!;
  const status = await __deps.probe(`https://${auth.targetDomain}${probe.path}`, cookieHeaderFor(cookies));
  return probe.alive.includes(status);
}

// Swallowed side-effect failures are logged by code only: an error message
// from a destination or the DB could echo a value.
function warn(what: string, code: string): void {
  console.warn(`[reconnect] ${what} failed (${code})`);
}

async function attempt(userId: string, integration: string, auth: RecipeAuth): Promise<ReconnectOutcome> {
  const state = await getReconnectState(userId, integration);
  if (!canAttemptReconnect(state)) return { ok: false, reason: "COOLDOWN" };
  // A human mid-connect owns the browser. `activeProfiles` is not this signal:
  // a warm chromium holds it for its whole life.
  if (isConnectInProgress(userId)) return { ok: false, reason: "BUSY" };

  const started = Date.now();
  const deadline = started + (auth.reconnect.timeoutMs ?? DEFAULT_RUN_MS);
  const capture = () => captureLiveCookies(userId, auth.targetDomain, auth.cookieDomains);

  let tabId: string | null = null;
  let phase = "verify"; // label for the failure record: "open", "step i", or "verify"
  let stepIndex = -1;
  try {
    // Fast path: the profile may already hold a live app session. Only capture
    // and probe fall through to the recipe; a commit failure is a failure.
    if (auth.session.probe && getWarmSession(userId)) {
      let live: CookieData | null = null;
      try {
        const data = await withDeadline(capture(), deadline);
        if (data.cookies.length && (await withDeadline(probeAlive(auth, data.cookies), deadline))) live = data;
      } catch { /* fall through to the recipe */ }
      if (live) return await commit(userId, integration, live, started);
    }

    phase = "open";
    const opened = await withDeadline(openTab(userId), deadline);
    if (!opened.ok) throw new StepError("BROWSER_ERROR");
    tabId = opened.tab.id;
    const page: PageHandle = opened.tab;
    const allowed = allowedHosts(auth);
    const bindings = state.bindings ?? {};
    const usedNames: string[] = [];
    let navigated = false;

    // Plaintext lives only in the returned string, which goes straight to
    // fillSelector's CallArgument. Errors carry the reason code alone.
    const resolveValue = async (v: string): Promise<string> => {
      let out = v;
      for (const [, k] of [...v.matchAll(CRED_RE)]) {
        const name = bindings[k];
        const secret = name ? await readSecretValue(userId, name) : null;
        if (secret === null) throw new StepError("CREDENTIAL_UNBOUND");
        usedNames.push(name!);
        out = out.split(`{{cred:${k}}}`).join(secret);
      }
      return out;
    };

    for (const [i, step] of auth.reconnect.steps.entries()) {
      stepIndex = i;
      phase = `step ${i}`;
      const href = await withDeadline(currentUrl(page), deadline);
      if (!hostOk(href, allowed, navigated)) throw new StepError("HOST_NOT_ALLOWED");
      const timeoutMs = Math.min(stepTimeout(step), deadline - Date.now());
      if (timeoutMs <= 0) throw new StepError("TIMEOUT");
      await withDeadline(runStep(page, step, auth, timeoutMs, allowed, resolveValue), deadline);
      if ("goto" in step) navigated = true;
    }

    stepIndex = -1;
    phase = "verify";
    const data = await withDeadline(capture(), deadline);
    if (!data.cookies.length) throw new StepError("NO_COOKIES");
    if (auth.session.probe) {
      if (!(await withDeadline(probeAlive(auth, data.cookies), deadline))) throw new StepError("PROBE_FAILED");
    } else {
      const href = await withDeadline(currentUrl(page), deadline);
      if (!href || href.startsWith(auth.loginUrl)) throw new StepError("PROBE_FAILED");
    }
    if (usedNames.length) await touchUsed(userId, usedNames).catch(() => warn("vault touchUsed", "TOUCH_FAILED"));
    return await commit(userId, integration, data, started);
  } catch (e) {
    const reason: ReconnectReason = e instanceof StepError ? e.reason : "BROWSER_ERROR";
    const now = Date.now();
    await updateReconnectState(userId, integration, { deadAt: now, last: { at: now, ok: false, error: `${phase}: ${reason}` } });
    await auditLogger
      .log({ user_id: userId, integration, action: "REFRESH", success: false, error: reason, duration_ms: now - started })
      .catch(() => warn("audit log REFRESH", reason));
    return { ok: false, reason, ...(stepIndex >= 0 ? { step: stepIndex } : {}) };
  } finally {
    if (tabId) await closeTab(userId, tabId).catch(() => false);
  }
}

function stepTimeout(step: ReconnectStep): number {
  return ("timeoutMs" in step && step.timeoutMs) || DEFAULT_STEP_MS;
}

async function commit(userId: string, integration: string, data: CookieData, started: number): Promise<ReconnectOutcome> {
  await storeCookies(userId, integration, data); // clears deadAt
  await updateReconnectState(userId, integration, { last: { at: Date.now(), ok: true } });
  await auditLogger
    .log({ user_id: userId, integration, action: "REFRESH", success: true, duration_ms: Date.now() - started })
    .catch(() => warn("audit log REFRESH", "OK"));
  return { ok: true };
}

async function runStep(
  page: PageHandle,
  step: ReconnectStep,
  auth: RecipeAuth,
  timeoutMs: number,
  allowed: string[],
  resolveValue: (v: string) => Promise<string>
): Promise<void> {
  if ("goto" in step) {
    const url = step.goto === "loginUrl" ? auth.loginUrl
      : /^https?:\/\//i.test(step.goto) ? step.goto
      : `https://${auth.targetDomain}${step.goto}`;
    await page.cdp.send("Page.navigate", { url });
    if (__deps.GOTO_SETTLE_MS > 0) await new Promise((r) => setTimeout(r, __deps.GOTO_SETTLE_MS));
    return;
  }
  if ("click" in step) {
    try {
      await clickSelector(page, step.click, timeoutMs);
    } catch (e) {
      if (step.optional && e instanceof StepError && e.reason === "SELECTOR_NOT_FOUND") return;
      throw e;
    }
    return;
  }
  if ("fill" in step) {
    // fillSelector waits for the element and re-checks the host in the same
    // call that writes the value, bound to the verified element.
    const value = await resolveValue(step.value);
    await fillSelector(page, step.fill, value, timeoutMs, allowed);
    return;
  }
  if ("press" in step) { await pressKey(page, step.press); return; }
  if ("waitFor" in step) { await waitForSelector(page, step.waitFor, timeoutMs); return; }
  if ("waitUrl" in step) { await waitForUrl(page, step.waitUrl, timeoutMs); return; }
}
