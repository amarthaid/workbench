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
    hangNavigate: false, // Page.navigate never resolves
    throwOnKey: false, // Input.dispatchKeyEvent throws a plain (non-Step) Error
  };
  const flags = { storeFail: false, vaultDelayMs: {} as Record<string, number> };
  const sent: [string, any][] = [];
  const hostOf = (u: string) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
  const fakeTab = {
    id: "tab-1",
    cdp: {
      send: async (m: string, p?: any) => {
        sent.push([m, p]);
        if (m === "Page.navigate" && pageState.hangNavigate) return new Promise(() => {});
        if (m === "Input.dispatchKeyEvent" && pageState.throwOnKey) throw new Error("socket closed");
        if (m === "Page.navigate") { pageState.url = pageState.redirect ?? p.url; return {}; }
        if (m === "Runtime.evaluate") {
          const expr: string = p.expression;
          if (expr === "location.href") return { result: { value: pageState.url } };
          const sel = /const sel = ("(?:[^"\\]|\\.)*");/.exec(expr)?.[1];
          const present = sel ? pageState.elements.has(JSON.parse(sel)) : false;
          if (p.returnByValue === false) return { result: present ? { objectId: "obj-1" } : {} };
          return { result: { value: present ? { x: 1, y: 1 } : null } };
        }
        if (m === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-1" } } };
        if (m === "DOM.describeNode") return { node: { backendNodeId: 7 } };
        if (m === "Page.createIsolatedWorld") return { executionContextId: 42 };
        if (m === "DOM.resolveNode") return { object: { objectId: "iso-1" } };
        if (m === "Runtime.callFunctionOn") {
          const hosts: string[] = p.arguments?.[1]?.value ?? [];
          const host = hostOf(pageState.url);
          const ok = hosts.includes(host);
          return { result: { value: ok ? "OK" : "HOST" } };
        }
        if (m === "Input.dispatchKeyEvent" && (p.type === "rawKeyDown" || p.type === "keyDown")) pageState.afterLogin();
        return {};
      },
    },
  };
  const live = { cookies: [] as any[] };
  const vault: Record<string, string> = {};
  return { pageState, sent, fakeTab, live, vault, flags };
});

vi.mock("../src/auth/cookie", async (orig) => {
  const real = await orig<typeof import("../src/auth/cookie")>();
  return {
    ...real,
    storeCookies: vi.fn(async (...a: Parameters<typeof real.storeCookies>) => {
      if (h.flags.storeFail) throw new Error("db down");
      return real.storeCookies(...a);
    }),
  };
});

vi.mock("../src/auth/browser-session", async (orig) => ({
  ...(await orig<typeof import("../src/auth/browser-session")>()),
  openPrivateTab: vi.fn(async () => ({ ok: true, tab: h.fakeTab })),
  closePrivateTab: vi.fn(async () => true),
  getWarmSession: vi.fn(() => ({})),
  captureLiveCookies: vi.fn(async (_u: string, d: string) => ({ domain: d, cookies: h.live.cookies, capturedAt: 1 })),
}));
vi.mock("../src/vault/store", async (orig) => ({
  ...(await orig<typeof import("../src/vault/store")>()),
  readSecretValue: vi.fn(async (_u: string, n: string) => {
    const delay = h.flags.vaultDelayMs[n];
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return h.vault[n] ?? null;
  }),
  touchUsed: vi.fn(async () => {}),
}));
const auditLog = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: auditLog } }));

import { db } from "../src/db";
import { config } from "../src/config";
import { registry } from "../src/plugins/registry";
import { activeProfiles } from "../src/auth/profile-chromium";
import { storeCookies, clearReconnectFailure } from "../src/auth/cookie";
import { closePrivateTab, openPrivateTab } from "../src/auth/browser-session";
import { touchUsed } from "../src/vault/store";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { markConnectStarted, markConnectEnded } from "../src/auth/reconnect/connect-lock";
import { reconnectSession, canAttemptReconnect, ensureCookieSession, __deps, __resetRunMemory, RECONNECT_COOLDOWN_MS } from "../src/auth/reconnect/runner";
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
    timeoutMs: 10000,
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
  pageState.hangNavigate = false;
  pageState.throwOnKey = false;
  h.flags.storeFail = false;
  h.flags.vaultDelayMs = {};
  __deps.GOTO_SETTLE_MS = 0;
  markConnectEnded(U);
  pageState.elements = new Set(["#user", "#pass"]);
  probeStatus = 401;
  pageState.afterLogin = () => { live.cookies = [goodCookie]; probeStatus = 200; };
  live.cookies = [];
  __deps.probe = vi.fn(async () => probeStatus);
  Object.assign(vault, { acme_user: "dev@example.com", acme_pw: "pw-abc" });
  activeProfiles.clear();
  __resetRunMemory();
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
    expect(closePrivateTab).toHaveBeenCalledWith(U, "tab-1");
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

  it("busy (a human is mid-connect): no run, nothing recorded", async () => {
    markConnectStarted(U);
    try {
      expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "BUSY" });
      const st = await getReconnectState(U, I);
      expect(st.last).toBeUndefined();
      expect(st.deadAt).toBeUndefined();
      expect(sent).toHaveLength(0);
      expect(openPrivateTab).not.toHaveBeenCalled();
      expect(auditLog).not.toHaveBeenCalled();
    } finally {
      markConnectEnded(U);
    }
  });

  it("a warm chromium (activeProfiles held) does not block: the fast path runs", async () => {
    activeProfiles.add(U); // a warm browser holds this for its whole life
    try {
      live.cookies = [goodCookie];
      probeStatus = 200;
      expect(await reconnectSession(U, I)).toEqual({ ok: true });
      expect(__deps.probe).toHaveBeenCalled();
      expect(openPrivateTab).not.toHaveBeenCalled();
    } finally {
      activeProfiles.delete(U);
    }
  });

  it("a fast-path commit failure is recorded, not retried through the recipe", async () => {
    live.cookies = [goodCookie];
    probeStatus = 200;
    h.flags.storeFail = true;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "BROWSER_ERROR" });
    expect(openPrivateTab).not.toHaveBeenCalled();
    expect(sent.find(([m]) => m === "Page.navigate")).toBeUndefined();
    expect((await getReconnectState(U, I)).last).toMatchObject({ ok: false });
  });

  it("tab limit reached is BUSY like a human mid-connect: no cooldown, no deadAt, no audit", async () => {
    vi.mocked(openPrivateTab).mockResolvedValueOnce({ ok: false, error: "BROWSER_TAB_LIMIT", limit: 1 });
    const out = await reconnectSession(U, I);
    expect(out).toEqual({ ok: false, reason: "BUSY" });
    const st = await getReconnectState(U, I);
    expect(st.last).toBeUndefined();
    expect(st.deadAt).toBeUndefined();
    expect(auditLog).not.toHaveBeenCalled();
    expect(closePrivateTab).not.toHaveBeenCalled();
  });

  it("openPrivateTab throwing is BROWSER_ERROR", async () => {
    vi.mocked(openPrivateTab).mockRejectedValueOnce(new Error("spawn failed"));
    expect(await reconnectSession(U, I)).toEqual({ ok: false, reason: "BROWSER_ERROR" });
    expect((await getReconnectState(U, I)).deadAt).toBeTypeOf("number");
  });

  it("a step that never resolves hits the run deadline: TIMEOUT, tab closed", async () => {
    pageState.hangNavigate = true;
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1", auth: { ...auth, reconnect: { ...auth.reconnect, timeoutMs: 300 } },
    } as any);
    const t0 = Date.now();
    const out = await reconnectSession(U, I);
    expect(out).toEqual({ ok: false, reason: "TIMEOUT", step: 0 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(closePrivateTab).toHaveBeenCalledWith(U, "tab-1");
    expect((await getReconnectState(U, I)).last?.error).toBe("step 0: TIMEOUT");
  });

  it("an orphaned fill whose vault read lands after the deadline never delivers the credential", async () => {
    h.flags.vaultDelayMs = { acme_pw: 400 }; // resolves well after the 150 ms deadline
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1", auth: { ...auth, reconnect: { ...auth.reconnect, timeoutMs: 150 } },
    } as any);
    const out = await reconnectSession(U, I);
    expect(out).toEqual({ ok: false, reason: "TIMEOUT", step: 2 });
    // Let the orphaned step finish its vault read, then flush the event loop.
    await new Promise((r) => setTimeout(r, 400 + 50));
    expect(deliveries()).toHaveLength(0);
    expect(JSON.stringify(sent)).not.toContain("pw-abc");
    // Nothing after the abandoned fill ran either.
    expect(sent.find(([m]) => m === "Input.dispatchKeyEvent")).toBeUndefined();
  });

  it("on failure the tab is closed before the failure is recorded, and only once", async () => {
    let lastAtClose: unknown = "unset";
    vi.mocked(closePrivateTab).mockImplementationOnce(async () => {
      lastAtClose = (await getReconnectState(U, I)).last;
      return true;
    });
    pageState.afterLogin = () => {}; // NO_COOKIES at verify
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "NO_COOKIES" });
    expect(lastAtClose).toBeUndefined(); // closed first ...
    expect((await getReconnectState(U, I)).last).toMatchObject({ ok: false }); // ... recorded after
    expect(closePrivateTab).toHaveBeenCalledTimes(1);
  });

  it("a non-StepError exception maps to BROWSER_ERROR and the tab is closed", async () => {
    pageState.throwOnKey = true;
    const out = await reconnectSession(U, I);
    expect(out).toEqual({ ok: false, reason: "BROWSER_ERROR", step: 3 });
    expect(closePrivateTab).toHaveBeenCalledWith(U, "tab-1");
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain("socket closed");
  });

  it("after a goto, an empty href (failed evaluate) fails closed with HOST_NOT_ALLOWED", async () => {
    pageState.redirect = ""; // location.href now reads ""
    const out = await reconnectSession(U, I);
    expect(out).toMatchObject({ ok: false, reason: "HOST_NOT_ALLOWED", step: 1 });
    expect(deliveries()).toHaveLength(0);
  });

  describe("without a probe", () => {
    const noProbe = { ...auth, session: { dead: { status: [401] } } };
    beforeEach(() => {
      vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth: noProbe } as any);
    });

    it("succeeds when the page left the login URL", async () => {
      pageState.afterLogin = () => { live.cookies = [goodCookie]; pageState.url = "https://app.example.com/home"; };
      expect(await reconnectSession(U, I)).toEqual({ ok: true });
    });

    it("an empty current URL is PROBE_FAILED", async () => {
      pageState.afterLogin = () => { live.cookies = [goodCookie]; pageState.url = ""; };
      expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "PROBE_FAILED" });
    });

    it("still on the login URL is PROBE_FAILED", async () => {
      pageState.afterLogin = () => { live.cookies = [goodCookie]; };
      expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "PROBE_FAILED" });
    });
  });

  it("swallowed audit / touchUsed errors warn by code only and do not change the outcome", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    auditLog.mockRejectedValueOnce(new Error("audit down: pw-abc"));
    vi.mocked(touchUsed).mockRejectedValueOnce(new Error("db down: pw-abc"));
    try {
      expect(await reconnectSession(U, I)).toEqual({ ok: true });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("pw-abc");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("down");
    } finally {
      warn.mockRestore();
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

  it("credential delivery is allowed only on targetDomain + allowHosts, never cookieDomains", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1",
      auth: { ...auth, cookieDomains: ["app.example.com", ".example.com"], reconnect: { ...auth.reconnect, allowHosts: [".Login.Example.com"] } },
    } as any);
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    const hostLists = sent.filter(([m]) => m === "Runtime.callFunctionOn").map(([, p]) => p.arguments[1].value);
    expect(hostLists.length).toBeGreaterThan(0);
    for (const hosts of hostLists) expect(hosts).toEqual(["app.example.com", "login.example.com"]);
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

describe("the cooldown cannot be dodged", () => {
  const navigations = () => sent.filter(([m]) => m === "Page.navigate");
  const deleteAndImport = async () => {
    // What DELETE /api/connections/:i then POST .../session/import (both
    // API-key reachable) do to the row: drop it, then upsert a fresh one.
    await db.run("DELETE FROM connections WHERE user_id = ? AND integration = ?", [U, I]);
    await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old" }], capturedAt: 1 });
  };

  it("a failure survives the connection row being deleted and re-imported", async () => {
    pageState.afterLogin = () => {};
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "NO_COOKIES" });
    await deleteAndImport();
    expect((await getReconnectState(U, I)).last).toBeUndefined(); // the DB record is gone with the row
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
  });

  it("a failure made while the row was deleted mid-run still holds", async () => {
    pageState.afterLogin = () => {};
    __deps.probe = vi.fn(async () => {
      await db.run("DELETE FROM connections WHERE user_id = ? AND integration = ?", [U, I]);
      return 401;
    });
    live.cookies = [goodCookie]; // reaches the probe, which deletes the row and fails
    expect((await reconnectSession(U, I)).ok).toBe(false);
    await deleteAndImport();
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
  });

  it("a failure holds even when the state cannot be written (config not a JSON object)", async () => {
    await db.run("UPDATE connections SET config = '[]' WHERE user_id = ? AND integration = ?", [U, I]);
    expect((await reconnectSession(U, I)).ok).toBe(false); // bindings unreadable -> CREDENTIAL_UNBOUND
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
  });

  it("a portal-session clear after the delete lifts the hold", async () => {
    pageState.afterLogin = () => {};
    expect((await reconnectSession(U, I)).ok).toBe(false);
    await deleteAndImport();
    await clearReconnectFailure(U, I); // what only a portal-session capture/import calls
    await updateReconnectState(U, I, { bindings: { username: "acme_user", password: "acme_pw" } });
    pageState.afterLogin = () => { live.cookies = [goodCookie]; probeStatus = 200; };
    sent.length = 0;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(deliveries()).toHaveLength(1);
  });

  it("a recipe success that dies again inside the cooldown does not rerun the recipe", async () => {
    vi.spyOn(registry, "getIntegration").mockReturnValue({
      name: I, version: "1", auth: { ...auth, session: { dead: { status: [401] } } },
    } as any);
    pageState.afterLogin = () => { live.cookies = [goodCookie]; pageState.url = "https://app.example.com/home"; };
    expect(await reconnectSession(U, I)).toEqual({ ok: true }); // probe-less: "left the login URL"
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(deliveries()).toHaveLength(0);
    expect((await getReconnectState(U, I)).deadAt).toBeTypeOf("number");
  });

  it("a recipe success holds the recipe even after delete + import", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    await deleteAndImport();
    live.cookies = []; // the profile has no live session either: only the recipe could help
    probeStatus = 401;
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
  });

  it("inside the cooldown the fast path still recovers a session the profile holds", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true }); // recipe success: holds the window
    // The session dies inside 10 minutes; the profile still has a live one.
    live.cookies = [goodCookie];
    probeStatus = 200;
    sent.length = 0;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(navigations()).toHaveLength(0); // no recipe step ran
    expect(deliveries()).toHaveLength(0);
  });

  it("after a failure, the fast path still recovers; the recipe stays held", async () => {
    pageState.afterLogin = () => {};
    expect((await reconnectSession(U, I)).ok).toBe(false);
    live.cookies = [goodCookie];
    probeStatus = 200;
    sent.length = 0;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(navigations()).toHaveLength(0);
  });

  it("a fast-path success never shortens the recipe's window", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true }); // 1. recipe success
    // 2-3. death, the profile still has a live session: fast path recovers
    live.cookies = [goodCookie];
    probeStatus = 200;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    // 4. death again, and this time the profile has nothing
    live.cookies = [];
    probeStatus = 401;
    sent.length = 0;
    // 5. the recipe must not run again inside its window
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
    expect(deliveries()).toHaveLength(0);
  });

  it("... nor after the row is deleted and re-imported in between", async () => {
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    live.cookies = [goodCookie];
    probeStatus = 200;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    await deleteAndImport();
    live.cookies = [];
    probeStatus = 401;
    sent.length = 0;
    expect(await reconnectSession(U, I)).toMatchObject({ ok: false, reason: "COOLDOWN" });
    expect(navigations()).toHaveLength(0);
  });

  it("a fast-path success does not hold the recipe", async () => {
    live.cookies = [goodCookie];
    probeStatus = 200;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    live.cookies = [];
    probeStatus = 401;
    expect(await reconnectSession(U, I)).toEqual({ ok: true });
    expect(deliveries()).toHaveLength(1);
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

  it("canAttemptReconnect: a recipe success holds too; a later portal clear lifts either", () => {
    const now = 1_000_000_000;
    expect(canAttemptReconnect({ recipeAt: now - 1000 }, now)).toBe(false);
    expect(canAttemptReconnect({ recipeAt: now - RECONNECT_COOLDOWN_MS }, now)).toBe(true);
    // a later fast-path success does not lift it; a later portal clear does
    expect(canAttemptReconnect({ recipeAt: now - 1000, last: { at: now - 10, ok: true } }, now)).toBe(false);
    expect(canAttemptReconnect({ recipeAt: now - 1000, clearedAt: now - 10 }, now)).toBe(true);
    expect(canAttemptReconnect({ last: { at: now - 1000, ok: false }, clearedAt: now - 500 }, now)).toBe(true);
    expect(canAttemptReconnect({ last: { at: now - 1000, ok: false }, clearedAt: now - 2000 }, now)).toBe(false);
  });
});

describe("ensureCookieSession", () => {
  it("revives a dead session", async () => {
    await updateReconnectState(U, I, { deadAt: Date.now() });
    expect(await ensureCookieSession(U, I)).toBe(true);
    expect((await getReconnectState(U, I)).deadAt).toBeUndefined();
  });

  it("revives cookies whose expiry passed overnight (no deadAt was ever set): exactly one run", async () => {
    await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old", expires: 1 }], capturedAt: 1 });
    expect((await getReconnectState(U, I)).deadAt).toBeUndefined();
    expect(await ensureCookieSession(U, I)).toBe(true);
    expect(openPrivateTab).toHaveBeenCalledTimes(1);
    expect(deliveries()).toHaveLength(1);
  });

  it("expired cookies inside the cooldown do not run the recipe", async () => {
    await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old", expires: 1 }], capturedAt: 1 });
    await updateReconnectState(U, I, { last: { at: Date.now(), ok: false, error: "verify: NO_COOKIES" } });
    expect(await ensureCookieSession(U, I)).toBe(false);
    expect(openPrivateTab).not.toHaveBeenCalled();
  });

  it("inside the cooldown, a session the profile still holds is recovered without the recipe", async () => {
    await storeCookies(U, I, { domain: "app.example.com", cookies: [{ ...goodCookie, value: "tok-old", expires: 1 }], capturedAt: 1 });
    await updateReconnectState(U, I, { recipeAt: Date.now(), last: { at: Date.now(), ok: true } });
    live.cookies = [goodCookie];
    probeStatus = 200;
    expect(await ensureCookieSession(U, I)).toBe(true);
    expect(openPrivateTab).not.toHaveBeenCalled();
  });

  it("no cookie row: no run", async () => {
    await db.run("DELETE FROM connections WHERE user_id = ?", [U]);
    expect(await ensureCookieSession(U, I)).toBe(false);
    expect(openPrivateTab).not.toHaveBeenCalled();
  });
});
