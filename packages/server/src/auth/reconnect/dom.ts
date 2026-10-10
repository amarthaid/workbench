import { click, typeText, type PageHandle } from "../browser-session";

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

export async function fillSelector(page: PageHandle, selector: string, value: string, timeoutMs: number): Promise<void> {
  const { x, y } = await waitForSelector(page, selector, timeoutMs);
  await click(page, x, y);
  // Clear without touching the value: select the field's content, then insert.
  await evalValue(page, `(() => { const el = document.activeElement; if (el && "select" in el) el.select(); })()`);
  await typeText(page, value);
}

export async function currentUrl(page: PageHandle): Promise<string> {
  const v = await evalValue(page, "location.href").catch(() => "");
  return typeof v === "string" ? v : "";
}

export async function waitForUrl(page: PageHandle, prefix: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const href = await currentUrl(page);
    if (href) {
      if (/^https?:\/\//i.test(prefix) ? href.startsWith(prefix) : safePath(href).startsWith(prefix)) return;
    }
    if (Date.now() >= deadline) throw new StepError("TIMEOUT");
    await sleep(POLL_MS);
  }
}

function safePath(href: string): string {
  try { return new URL(href).pathname; } catch { return ""; }
}
