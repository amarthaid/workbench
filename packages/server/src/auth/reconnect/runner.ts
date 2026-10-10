import type { CookieConfig, ReconnectStep } from "@a-workbench/shared";
import { registry } from "../../plugins/registry";
import { auditLogger } from "../../audit/logger";
import { readSecretValue, touchUsed } from "../../vault/store";
import { activeProfiles } from "../profile-chromium";
import { openTab, closeTab, getWarmSession, captureLiveCookies, pressKey, type PageHandle } from "../browser-session";
import { storeCookies, type CookieData } from "../cookie";
import { getReconnectState, updateReconnectState, type ReconnectState } from "./state";
import { clickSelector, fillSelector, waitForSelector, waitForUrl, currentUrl, StepError, type ReconnectReason } from "./dom";
import { mayOwnBrowser } from "./affinity";

export const RECONNECT_COOLDOWN_MS = 600_000;
const DEFAULT_RUN_MS = 30_000;
const DEFAULT_STEP_MS = 10_000;
const GOTO_SETTLE_MS = 500;
const CRED_RE = /\{\{cred:([a-z0-9_]+)\}\}/g;

export type ReconnectOutcome =
  | { ok: true }
  | { ok: false; reason: ReconnectReason | "COOLDOWN" | "BUSY" | "NOT_OWNER" | "NO_RECIPE"; step?: number };

type RecipeAuth = CookieConfig & Required<Pick<CookieConfig, "session" | "reconnect">>;

// Test seam: the liveness probe is the only network call the runner makes itself.
export const __deps = {
  async probe(url: string, cookieHeader: string): Promise<number> {
    const res = await fetch(url, { headers: { Cookie: cookieHeader }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return res.status;
  },
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

function hostOk(href: string, allowed: string[]): boolean {
  if (href === "about:blank" || href === "") return true;
  try {
    const h = new URL(href).hostname.toLowerCase();
    return allowed.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
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

async function attempt(userId: string, integration: string, auth: RecipeAuth): Promise<ReconnectOutcome> {
  const state = await getReconnectState(userId, integration);
  if (!canAttemptReconnect(state)) return { ok: false, reason: "COOLDOWN" };
  if (activeProfiles.has(userId)) return { ok: false, reason: "BUSY" };

  const started = Date.now();
  const capture = () => captureLiveCookies(userId, auth.targetDomain, auth.cookieDomains);

  // Fast path: the profile may already hold a live app session.
  if (auth.session.probe && getWarmSession(userId)) {
    try {
      const data = await capture();
      if (data.cookies.length && (await probeAlive(auth, data.cookies))) {
        return await commit(userId, integration, data, started);
      }
    } catch { /* fall through to the recipe */ }
  }

  let tabId: string | null = null;
  let stepIndex = -1;
  try {
    const opened = await openTab(userId);
    if (!opened.ok) throw new StepError("BROWSER_ERROR");
    tabId = opened.tab.id;
    const page: PageHandle = opened.tab;
    const deadline = started + (auth.reconnect.timeoutMs ?? DEFAULT_RUN_MS);
    const allowed = allowedHosts(auth);
    const bindings = state.bindings ?? {};
    const usedNames: string[] = [];

    const guardHost = async () => {
      if (!hostOk(await currentUrl(page), allowed)) throw new StepError("HOST_NOT_ALLOWED");
    };

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
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new StepError("TIMEOUT");
      await guardHost();
      await runStep(page, step, auth, Math.min(stepTimeout(step), remaining), allowed, resolveValue);
    }

    stepIndex = -1;
    const data = await capture();
    if (!data.cookies.length) throw new StepError("NO_COOKIES");
    if (auth.session.probe) {
      if (!(await probeAlive(auth, data.cookies))) throw new StepError("PROBE_FAILED");
    } else if ((await currentUrl(page)).startsWith(auth.loginUrl)) {
      throw new StepError("PROBE_FAILED");
    }
    if (usedNames.length) await touchUsed(userId, usedNames).catch(() => {});
    return await commit(userId, integration, data, started);
  } catch (e) {
    const reason: ReconnectReason = e instanceof StepError ? e.reason : "BROWSER_ERROR";
    const now = Date.now();
    const where = stepIndex >= 0 ? `step ${stepIndex}` : "verify";
    await updateReconnectState(userId, integration, { deadAt: now, last: { at: now, ok: false, error: `${where}: ${reason}` } });
    await auditLogger
      .log({ user_id: userId, integration, action: "REFRESH", success: false, error: reason, duration_ms: now - started })
      .catch(() => {});
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
    .catch(() => {});
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
    await new Promise((r) => setTimeout(r, GOTO_SETTLE_MS));
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
