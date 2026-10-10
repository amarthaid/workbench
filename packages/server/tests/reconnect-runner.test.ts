import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fake page that mirrors the CDP shapes dom.ts uses (see reconnect-dom.test.ts):
// locate-evaluate (returnByValue true) -> point|null; prepare-evaluate
// (returnByValue false) -> objectId; callFunctionOn -> "OK" | "HOST".
const h = vi.hoisted(() => {
  const pageState = {
    url: "about:blank",
    redirect: undefined as string | undefined,
    elements: new Set<string>(),
    afterLogin: () => {},
  };
  const sent: [string, any][] = [];
  const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const fakeTab = {
    id: "tab-1",
    cdp: {
      send: async (m: string, p?: any) => {
        sent.push([m, p]);
        if (m === "Page.navigate") { pageState.url = pageState.redirect ?? p.url; return {}; }
        if (m === "Runtime.evaluate") {
          const expr: string = p.expression;
          if (expr === "location.href") return { result: { value: pageState.url } };
          const sel = /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr)?.[1];
          const present = sel ? pageState.elements.has(JSON.parse(sel)) : false;
          if (p.returnByValue === false) return { result: present ? { objectId: "obj-1" } : {} };
          return { result: { value: present ? { x: 1, y: 1 } : null } };
        }
        if (m === "Runtime.callFunctionOn") {
          const hosts: string[] = p.arguments?.[1]?.value ?? [];
          const host = hostOf(pageState.url);
          const ok = hosts.some((d) => host === d || host.endsWith("." + d));
          return { result: { value: ok ? "OK" : "HOST" } };
        }
        if (m === "Input.dispatchKeyEvent" && p.type === "rawKeyDown") pageState.afterLogin();
        return {};
      },
    },
  };
  const live = { cookies: [] as any[] };
  const vault: Record<string, string> = {};
  return { pageState, sent, fakeTab, live, vault };
});

vi.mock("../src/auth/browser-session", async (orig) => ({
  ...(await orig<typeof import("../src/auth/browser-session")>()),
  openTab: vi.fn(async () => ({ ok: true, tab: h.fakeTab })),
  closeTab: vi.fn(async () => true),
  getWarmSession: vi.fn(() => ({})),
  captureLiveCookies: vi.fn(async (_u: string, d: string) => ({ domain: d, cookies: h.live.cookies, capturedAt: 1 })),
}));
vi.mock("../src/vault/store", async (orig) => ({
  ...(await orig<typeof import("../src/vault/store")>()),
  readSecretValue: vi.fn(async (_u: string, n: string) => h.vault[n] ?? null),
  touchUsed: vi.fn(async () => {}),
}));
const auditLog = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: auditLog } }));

import { db } from "../src/db";
import { config } from "../src/config";
import { registry } from "../src/plugins/registry";
import { activeProfiles } from "../src/auth/profile-chromium";
import { storeCookies } from "../src/auth/cookie";
import { closeTab } from "../src/auth/browser-session";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { reconnectSession, canAttemptReconnect, __deps, RECONNECT_COOLDOWN_MS } from "../src/auth/reconnect/runner";
import { runWithBrowserAffinity, mayOwnBrowser } from "../src/auth/reconnect/affinity";

const { pageState, sent, live, vault } = h;
const U = "user-runner";
const I = "acme-cookie";
const auth = {
  type: "cookie" as const,
  loginUrl: "https://app.example.com/login",
  targetDomain: "app.example.com",
  cookieDomains: ["app.example.com"],
  session: { probe: { path: "/api/me", alive: [200] }, dead: { status: [401] } },
  reconnect: {
    credentials: [{ key: "username", label: "U" }, { key: "password", label: "P", secret: true }],
    steps: [
      { goto: "loginUrl" },
      { fill: "#user", value: "{{cred:username}}" },
      { fill: "#pass", value: "{{cred:password}}" },
      { press: "Enter" },
    ] as any[],
    timeoutMs: 3000,
  },
};
const goodCookie = { name: "sid", value: "tok-new", domain: "app.example.com", path: "/", expires: 9999999999 };

const deliveries = () =>
  sent.filter(([m, p]) => m === "Runtime.callFunctionOn" && JSON.stringify(p.arguments).includes("pw-abc"));

let probeStatus = 401;
const savedInternal = config.INTERNAL_MCP_URL;

beforeEach(async () => {
  sent.length = 0;
  auditLog.mockClear();
  pageState.url = "about:blank";
  pageState.redirect = undefined;
  pageState.elements = new Set(["#user", "#pass"]);
  probeStatus = 401;
  pageState.afterLogin = () => { live.cookies = [goodCookie]; probeStatus = 200; };
  live.cookies = [];
  __deps.probe = vi.fn(async () => probeStatus);
  Object.assign(vault, { acme_user: "dev@example.com", acme_pw: "pw-abc" });
  activeProfiles.clear();
  config.INTERNAL_MCP_URL = undefined;
  vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth } as any);
  await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
  await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old" }], capturedAt: 1 });
  await updateReconnectState(U, I, { bindings: { username: "acme_user", password: "acme_pw" } });
});

afterEach(() => {
  config.INTERNAL_MCP_URL = savedInternal;
});

describe("reconnectSession", () => {
  it("runs the recipe, stores new cookies and records success", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(deliveries()).toHaveLength(1);
    // The credential never appears in any evaluate expression or function body.
    for (const [m, p] of sent) {
      if (m === "Runtime.evaluate") expect(p.expression).not.toContain("pw-abc");
      if (m === "Runtime.callFunctionOn") expect(p.functionDeclaration).not.toContain("pw-abc");
    }
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeUndefined();
    expect(st.last?.ok).toBe(true);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "REFRESH", success: true, integration: I }));
    expect(closeTab).toHaveBeenCalledWith(U, "tab-1");
  });

  it("fast path: a live profile session skips the steps", async () => {
    live.cookies = [goodCookie];
    probeStatus = 200;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(sent.find(([m]) => m === "Page.navigate")).toBeUndefined();
    expect((await getReconnectState(U, I)).last?.ok).toBe(true);
  });

  it("single flight: concurrent calls share one run", async () => {
    const [a, b, c] = await Promise.all([reconnectSession(U, I), reconnectSession(U, I), reconnectSession(U, I)]);
    expect([a, b, c]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(deliveries()).toHaveLength(1);
    expect(sent.filter(([m]) => m === "Page.navigate")).toHaveLength(1);
  });

  it("wrong password: records failure and then honours the cooldown", async () => {
    pageState.afterLogin = () => {}; // login does nothing
    const first = await reconnectSession(U, I);
    expect(first).toMatchObject({ ok: false, reason: "NO_COOKIES" });
    expect(first).not.toHaveProperty("step");
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeTypeOf("number");
    expect(st.last).toMatchObject({ ok: false, error: "verify: NO_COOKIES" });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "REFRESH", success: false, error: "NO_COOKIES" }));
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(sent).toHaveLength(0);
  });

  it("probe rejecting the new cookies is PROBE_FAILED", async () => {
    pageState.afterLogin = () => { live.cookies = [goodCookie]; }; // probe stays 401
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "PROBE_FAILED" });
    expect((await getReconnectState(U, I)).last?.error).toBe("verify: PROBE_FAILED");
  });

  it("retries after the cooldown elapses", async () => {
    await updateReconnectState(U, I, { last: { at: Date.now() - RECONNECT_COOLDOWN_MS - 1, ok: false } });
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
  });

  it("busy profile: no run, nothing recorded", async () => {
    activeProfiles.add(U);
    try {
      expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "BUSY" });
      const st = await getReconnectState(U, I);
      expect(st.last).toBeUndefined();
      expect(st.deadAt).toBeUndefined();
      expect(sent).toHaveLength(0);
      expect(auditLog).not.toHaveBeenCalled();
    } finally {
      activeProfiles.delete(U);
    }
  });

  it("host guard: aborts before fill when the page left the allowlist", async () => {
    pageState.redirect = "https://evil.example.org/login"; // login page bounces off-allowlist
    const out = await reconnectSession(U, I);
    expect(out).toMatchObject({ ok: false, reason: "HOST_NOT_ALLOWED", step: 1 });
    expect(sent.find(([m]) => m === "Runtime.callFunctionOn")).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain("pw-abc");
    expect(JSON.stringify(sent)).not.toContain("dev@example.com");
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeTypeOf("number");
    expect(st.last).toMatchObject({ ok: false, error: "step 1: HOST_NOT_ALLOWED" });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: "HOST_NOT_ALLOWED" }));
  });

  it("unbound credential fails with CREDENTIAL_UNBOUND and leaks nothing", async () => {
    await updateReconnectState(U, I, { bindings: { username: "acme_user" } });
    const out = await reconnectSession(U, I);
    expect(out).toMatchObject({ ok: false, reason: "CREDENTIAL_UNBOUND", step: 2 });
    const st = await getReconnectState(U, I);
    expect(JSON.stringify(st)).not.toContain("pw-abc");
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain("pw-abc");
  });

  it("optional click is skipped when absent", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1",
      auth: { ...auth, reconnect: { ...auth.reconnect, steps: [
        { goto: "loginUrl" },
        { click: "#account-picker", optional: true, timeoutMs: 200 },
        ...auth.reconnect.steps.slice(1),
      ] } },
    } as any);
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
  });

  it("returns NO_RECIPE for an integration without reconnect", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth: { ...auth, reconnect: undefined } } as any);
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "NO_RECIPE" });
  });

  it("NOT_OWNER outside the affinity scope when clustered: marks dead, records no attempt", async () => {
    config.INTERNAL_MCP_URL = "http://workbench.example.com/mcp";
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "NOT_OWNER" });
    const st = await getReconnectState(U, I);
    expect(st.deadAt).toBeTypeOf("number");
    expect(st.last).toBeUndefined();
    expect(auditLog).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(await runWithBrowserAffinity(() => reconnectSession(U, I))).toEqual({ ok: true });
  });
});

describe("affinity + cooldown helpers", () => {
  it("mayOwnBrowser is true unclustered or inside runWithBrowserAffinity", () => {
    expect(mayOwnBrowser()).toBe(true);
    config.INTERNAL_MCP_URL = "http://workbench.example.com/mcp";
    expect(mayOwnBrowser()).toBe(false);
    expect(runWithBrowserAffinity(() => mayOwnBrowser())).toBe(true);
  });

  it("canAttemptReconnect is false only inside the cooldown after a failure", () => {
    const now = 1_000_000_000;
    expect(canAttemptReconnect({}, now)).toBe(true);
    expect(canAttemptReconnect({ last: { at: now - 1000, ok: true } }, now)).toBe(true);
    expect(canAttemptReconnect({ last: { at: now - 1000, ok: false } }, now)).toBe(false);
    expect(canAttemptReconnect({ last: { at: now - RECONNECT_COOLDOWN_MS, ok: false } }, now)).toBe(true);
  });
});
