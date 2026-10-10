import { click, type PageHandle } from "../browser-session";

export type ReconnectReason =
  | "TIMEOUT" | "SELECTOR_NOT_FOUND" | "HOST_NOT_ALLOWED" | "CREDENTIAL_UNBOUND"
  | "NO_COOKIES" | "PROBE_FAILED" | "BROWSER_ERROR";

export class StepError extends Error {
  constructor(public reason: ReconnectReason, message?: string) {
    super(message ?? reason);
  }
}

export const POLL_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Locate a visible, enabled element and return its viewport centre, or null.
// `text=Label` matches clickable elements by case-insensitive visible text.
function locateExpr(selector: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled;
    };
    let el = null;
    if (sel.startsWith("text=")) {
      const want = sel.slice(5).trim().toLowerCase();
      const cands = document.querySelectorAll('button, a, [role="button"], input[type="submit"], input[type="button"]');
      el = [...cands].find((c) => visible(c) && ((c.innerText || c.value || "").trim().toLowerCase().includes(want))) || null;
    } else {
      el = [...document.querySelectorAll(sel)].find(visible) || null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`;
}

async function evalValue(page: PageHandle, expression: string): Promise<unknown> {
  const r = (await page.cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: unknown };
  };
  return r.result?.value;
}

export async function waitForSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // A navigation mid-poll destroys the execution context; treat as "not yet".
    const v = await evalValue(page, locateExpr(selector)).catch(() => null);
    if (v && typeof v === "object") return v as { x: number; y: number };
    if (Date.now() >= deadline) throw new StepError("SELECTOR_NOT_FOUND");
    await sleep(POLL_MS);
  }
}

export async function clickSelector(page: PageHandle, selector: string, timeoutMs: number): Promise<void> {
  const { x, y } = await waitForSelector(page, selector, timeoutMs);
  await click(page, x, y);
}

// Fixed constant: contains no credential. The value arrives as a CallArgument.
// It runs in an ISOLATED world (pristine built-ins; page scripts cannot patch
// String/Array/Object prototypes or the value setter), and the host check is
// an EXACT hostname match in the same call that writes the value.
const DELIVER_FN = `function (v, hosts) {
  const h = location.hostname.toLowerCase();
  if (!hosts.includes(h)) return "HOST";
  if (document.activeElement !== this) this.focus();
  if (this.isContentEditable) { this.textContent = v; }
  else {
    const proto = this.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(this, v);
  }
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "OK";
}`;

const WORLD_NAME = "workbench-reconnect";

/**
 * `isAborted` is the caller's run-abort flag. It is checked immediately before
 * delivery, so a fill orphaned by a deadline (the caller stopped waiting but
 * cannot cancel the promise) never hands the value to the page.
 */
export async function fillSelector(
  page: PageHandle,
  selector: string,
  value: string,
  timeoutMs: number,
  allowedHosts: string[],
  isAborted: () => boolean = () => false
): Promise<void> {
  if (selector.startsWith("text=")) {
    throw new StepError("SELECTOR_NOT_FOUND", "text= selectors cannot target fill");
  }
  const { x, y } = await waitForSelector(page, selector, timeoutMs);
  await click(page, x, y);
  const send = (m: string, p?: Record<string, unknown>) => page.cdp.send(m, p) as Promise<any>;
  // Prepare (main world, selector only): focused, cleared, editable element or null.
  const prep = (await send("Runtime.evaluate", { expression: prepareFillExpr(selector), returnByValue: false }).catch(
    () => null
  )) as { result?: { objectId?: string }; exceptionDetails?: unknown } | null;
  if (!prep || prep.exceptionDetails) throw new StepError("SELECTOR_NOT_FOUND");
  const mainId = prep.result?.objectId;
  if (!mainId) throw new StepError("SELECTOR_NOT_FOUND");
  let isoId: string | undefined;
  try {
    let res: { result?: { value?: unknown }; exceptionDetails?: unknown };
    try {
      // Re-resolve the same node inside an isolated world of the main frame.
      // An element outside the main frame fails resolveNode: fail closed.
      const tree = await send("Page.getFrameTree");
      const frameId = tree?.frameTree?.frame?.id;
      const desc = await send("DOM.describeNode", { objectId: mainId });
      const backendNodeId = desc?.node?.backendNodeId;
      if (!frameId || typeof backendNodeId !== "number") throw new Error("no frame/node");
      const world = await send("Page.createIsolatedWorld", {
        frameId,
        worldName: WORLD_NAME,
        grantUniveralAccess: false,
      });
      const executionContextId = world?.executionContextId;
      if (typeof executionContextId !== "number") throw new Error("no context");
      const resolved = await send("DOM.resolveNode", { backendNodeId, executionContextId });
      isoId = resolved?.object?.objectId;
      if (!isoId) throw new Error("no isolated handle");
      if (isAborted()) throw new StepError("TIMEOUT");
      res = await send("Runtime.callFunctionOn", {
        objectId: isoId,
        functionDeclaration: DELIVER_FN,
        arguments: [{ value }, { value: allowedHosts.map((h) => h.toLowerCase()) }],
        returnByValue: true,
      });
    } catch (e) {
      if (e instanceof StepError) throw e;
      throw new StepError("BROWSER_ERROR");
    }
    if (res.exceptionDetails) throw new StepError("BROWSER_ERROR");
    const out = res.result?.value;
    if (out === "HOST") throw new StepError("HOST_NOT_ALLOWED");
    if (out !== "OK") throw new StepError("SELECTOR_NOT_FOUND");
  } finally {
    await send("Runtime.releaseObject", { objectId: mainId }).catch(() => {});
    if (isoId) await send("Runtime.releaseObject", { objectId: isoId }).catch(() => {});
  }
}

function prepareFillExpr(selector: string): string {
  return `(() => {
    const sel = ${JSON.stringify(selector)};
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.disabled;
    };
    const el = [...document.querySelectorAll(sel)].find(visible) || null;
    if (!el) return null;
    const tag = el.tagName;
    const badTypes = ["hidden", "checkbox", "radio", "submit", "button", "file", "image", "reset", "range", "color"];
    const isField = tag === "TEXTAREA" || (tag === "INPUT" && !badTypes.includes((el.type || "text").toLowerCase()));
    if (!(isField || el.isContentEditable) || el.disabled || el.readOnly) return null;
    el.focus();
    if (isField) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.textContent = "";
    }
    return document.activeElement === el ? el : null;
  })()`;
}

export async function currentUrl(page: PageHandle): Promise<string> {
  const v = await evalValue(page, "location.href").catch(() => "");
  return typeof v === "string" ? v : "";
}

export async function waitForUrl(page: PageHandle, prefix: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const href = await currentUrl(page);
    if (href && urlMatches(href, prefix)) return;
    if (Date.now() >= deadline) throw new StepError("TIMEOUT");
    await sleep(POLL_MS);
  }
}

// Compare parsed URLs, never raw strings: a raw startsWith lets
// "https://app.example.com.evil.org/" or "https://app.example.com@evil.org/"
// satisfy the prefix "https://app.example.com".
function urlMatches(href: string, prefix: string): boolean {
  try {
    const h = new URL(href);
    if (/^https?:\/\//i.test(prefix)) {
      const p = new URL(prefix);
      if (h.origin !== p.origin) return false;
      return p.pathname === "/" || h.pathname.startsWith(p.pathname);
    }
    return h.pathname.startsWith(prefix);
  } catch {
    return false;
  }
}
