import type { CookieConfig, ReconnectStep } from "./types";

export const CRED_REF_RE = /\{\{cred:([a-z0-9_]+)\}\}/g;
export const RECONNECT_MAX_TIMEOUT_MS = 120_000;

export function credentialRefs(value: string): string[] {
  return [...value.matchAll(CRED_REF_RE)].map((m) => m[1]);
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((d) => host === d || host.endsWith("." + d));
}

/** Every string-valued field of a step except fill.value. */
function nonFillStrings(step: ReconnectStep): string[] {
  return Object.entries(step)
    .filter(([k, v]) => typeof v === "string" && !("fill" in step && k === "value"))
    .map(([, v]) => v as string);
}

/**
 * Structural checks the type system cannot express. Returned messages are for
 * plugin authors (logged at load), so they name the step index.
 */
export function validateCookieRecipe(auth: CookieConfig): string[] {
  const errs: string[] = [];
  const r = auth.reconnect;
  if (!r) return errs;
  if (!auth.session?.dead) errs.push("reconnect requires session.dead");
  if (!Array.isArray(r.steps) || r.steps.length === 0) errs.push("reconnect.steps must be non-empty");
  if (r.timeoutMs !== undefined && (r.timeoutMs <= 0 || r.timeoutMs > RECONNECT_MAX_TIMEOUT_MS)) {
    errs.push(`reconnect.timeoutMs must be in (0, ${RECONNECT_MAX_TIMEOUT_MS}]`);
  }
  const declared = new Set((r.credentials ?? []).map((c) => c.key));
  const allowed = [auth.targetDomain, ...(auth.cookieDomains ?? []), ...(r.allowHosts ?? [])]
    .map((d) => d.replace(/^\./, "").toLowerCase());

  (r.steps ?? []).forEach((step, i) => {
    for (const s of nonFillStrings(step)) {
      if (credentialRefs(s).length) errs.push(`step ${i}: {{cred:…}} is only allowed in fill.value`);
    }
    if ("fill" in step) {
      for (const key of credentialRefs(step.value)) {
        if (!declared.has(key)) errs.push(`step ${i}: undeclared credential "${key}"`);
      }
    }
    const url = "goto" in step ? step.goto : "waitUrl" in step ? step.waitUrl : null;
    if (url && url !== "loginUrl" && /^https?:\/\//i.test(url)) {
      const host = hostOf(url);
      if (!host || !hostAllowed(host, allowed)) {
        errs.push(`step ${i}: host ${host ?? url} not in targetDomain/cookieDomains/allowHosts`);
      }
    }
  });
  return errs;
}
