import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The recipe tab types a vault credential. It must be invisible to every
// browser_* tool: an agent with main-world evaluate on that page could listen
// for the input event that carries the plaintext.

const { spawnMock, cdpCallMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), cdpCallMock: vi.fn() }));

vi.mock("../src/auth/profile-chromium", async () => {
  const real = await vi.importActual<typeof import("../src/auth/profile-chromium")>("../src/auth/profile-chromium");
  return { ...real, activeProfiles: new Set<string>(), spawnProfileChromium: spawnMock, cdpCall: cdpCallMock };
});

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 3; });
    constructor(_url: string) {
      super();
      setImmediate(() => this.emit("open"));
    }
  }
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

vi.mock("../src/auth/cdp-bridge", () => ({
  mintSessionKey: vi.fn().mockReturnValue("test-session-id"),
  verifySessionKey: vi.fn((key: string | undefined) => key === "test-session-id"),
  SESSION_HEADER: "x-browser-session",
}));

import {
  ensureSession,
  getWarmSession,
  closeBrowserSession,
  openPrivateTab,
  closePrivateTab,
  isPrivateTarget,
  getTab,
  defaultTab,
  closeTab,
  browserClient,
} from "../src/auth/browser-session";
import { activeProfiles } from "../src/auth/profile-chromium";
import { browserPlugin } from "../src/plugins/internal/browser";

const U = "u-private";

function fakeProc() {
  const { EventEmitter } = require("node:events");
  const p = new EventEmitter();
  p.kill = vi.fn();
  return p;
}

const tool = (name: string) => browserPlugin.tools.find((t) => t.name === name)!;
const call = (name: string, args: Record<string, unknown> = {}) =>
  tool(name).handler({ userId: U } as any, args) as Promise<any>;

let targets: Array<{ targetId: string; type: string; url: string; title: string }>;
let sent: Array<{ method: string; params: Record<string, unknown> }>;

beforeEach(async () => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue({
    proc: fakeProc(),
    remotePort: 9999,
    cdpBrowserWsUrl: "ws://127.0.0.1:9999/browser",
    cdpPageWsUrl: "ws://127.0.0.1:9999/page",
    cdpPageTargetId: "T0",
  });
  activeProfiles.clear();
  await ensureSession(U);
  const client = await browserClient(getWarmSession(U)!);
  sent = [];
  targets = [{ targetId: "T0", type: "page", url: "about:blank", title: "" }];
  (client as unknown as { send: unknown }).send = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    sent.push({ method, params });
    if (method === "Target.createTarget") {
      // First create is the recipe tab; any later one is a fresh page.
      const id = targets.some((t) => t.targetId === "RECIPE") ? `NEW${targets.length}` : "RECIPE";
      targets.push({ targetId: id, type: "page", url: "https://app.example.com/login", title: "Login" });
      return { targetId: id };
    }
    if (method === "Target.getTargets") return { targetInfos: targets };
    return {};
  });
});

afterEach(async () => { await closeBrowserSession(U); });

describe("private (recipe) tabs", () => {
  it("open in chromium but are not registered as agent tabs", async () => {
    const r = await openPrivateTab(U);
    expect(r).toMatchObject({ ok: true, tab: { id: "RECIPE" } });
    expect(getTab(U, "RECIPE")).toBeUndefined();
    expect(getWarmSession(U)!.tabs.has("RECIPE")).toBe(false);
  });

  it("browser_tabs does not list them", async () => {
    await openPrivateTab(U);
    const out = await call("browser_tabs");
    expect(out.tabs.map((t: { session_id: string }) => t.session_id)).toEqual(["T0"]);
  });

  it("browser_evaluate and browser_close with the recipe tab id are BROWSER_TAB_NOT_FOUND", async () => {
    await openPrivateTab(U);
    expect(await call("browser_evaluate", { session_id: "RECIPE", expression: "1" })).toMatchObject({ error: "BROWSER_TAB_NOT_FOUND" });
    expect(await call("browser_close", { session_id: "RECIPE" })).toMatchObject({ error: "BROWSER_TAB_NOT_FOUND" });
    expect(await closeTab(U, "RECIPE")).toBe(false);
    expect(sent.find((x) => x.method === "Target.closeTarget")).toBeUndefined();
  });

  it("defaultTab never adopts one, even when it is the only free page", async () => {
    await openPrivateTab(U);
    await closeTab(U, "T0");
    targets = targets.filter((t) => t.targetId !== "T0");
    const t = await defaultTab(U);
    expect(t.id).not.toBe("RECIPE");
    expect(getWarmSession(U)!.defaultTabId).not.toBe("RECIPE");
    expect(getWarmSession(U)!.cdpPageWsUrl).not.toContain("RECIPE");
  });

  it("race: a defaultTab() running while openPrivateTab is mid-flight never adopts the new target", async () => {
    // createTarget has answered, but the private tab's socket is not open yet:
    // the target exists in chromium and is in no map.
    await closeTab(U, "T0");
    targets = targets.filter((t) => t.targetId !== "T0");
    const opening = openPrivateTab(U);
    await new Promise((r) => setImmediate(r)); // let createTarget resolve; ws "open" is still pending
    expect(targets.map((t) => t.targetId)).toContain("RECIPE");
    const [d, listed] = await Promise.all([defaultTab(U), call("browser_tabs")]);
    const opened = await opening;
    expect(opened).toMatchObject({ ok: true, tab: { id: "RECIPE" } });
    expect(d.id).not.toBe("RECIPE");
    expect(getWarmSession(U)!.defaultTabId).not.toBe("RECIPE");
    expect(getTab(U, "RECIPE")).toBeUndefined();
    expect(listed.tabs.map((t: { session_id: string }) => t.session_id)).not.toContain("RECIPE");
  });

  it("isPrivateTarget is scoped per user and per chromium session", async () => {
    await openPrivateTab(U);
    expect(isPrivateTarget(U, "RECIPE")).toBe(true);
    expect(isPrivateTarget(U, "T0")).toBe(false);
    expect(isPrivateTarget("someone-else", "RECIPE")).toBe(false);
  });

  it("close: the handle is dropped, the id stays hidden (tombstone) for this chromium's life", async () => {
    await openPrivateTab(U);
    await closePrivateTab(U, "RECIPE");
    expect(getWarmSession(U)!.privateTabs.size).toBe(0);
    expect(await closePrivateTab(U, "RECIPE")).toBe(false); // second close is a no-op
    // A late Target.getTargets answer may still list the dying target: it must never surface.
    expect(isPrivateTarget(U, "RECIPE")).toBe(true);
    expect((await call("browser_tabs")).tabs.map((t: { session_id: string }) => t.session_id)).toEqual(["T0"]);
  });

  it("a private tab whose socket dies is dropped from the handles but stays hidden", async () => {
    const r = await openPrivateTab(U);
    if (!r.ok) throw new Error("open failed");
    (r.tab.cdp as unknown as { ws: { emit: (e: string) => void } }).ws.emit("close");
    expect(getWarmSession(U)!.privateTabs.has("RECIPE")).toBe(false);
    expect(isPrivateTarget(U, "RECIPE")).toBe(true);
    expect(getTab(U, "RECIPE")).toBeUndefined();
  });

  it("exit + restart: the new chromium inherits no private ids, handles or pending opens", async () => {
    await openPrivateTab(U);
    const old = getWarmSession(U)!;
    await closeBrowserSession(U);
    expect(isPrivateTarget(U, "RECIPE")).toBe(false); // no session, nothing private
    expect(old.privateTabs.size).toBe(0);
    await ensureSession(U);
    const fresh = getWarmSession(U)!;
    expect(fresh).not.toBe(old);
    expect(fresh.privateIds.size).toBe(0);
    expect(fresh.privateTabs.size).toBe(0);
    expect(fresh.pendingPrivateOpens).toBe(0);
  });

  describe("fail closed", () => {
    it("a target info missing its id or type is never listed or adopted", async () => {
      targets = [
        { targetId: "T0", type: "page", url: "about:blank", title: "" },
        { type: "page", url: "about:blank", title: "" } as any,
        { targetId: "NOTYPE", url: "about:blank", title: "" } as any,
      ];
      const ids = (await call("browser_tabs")).tabs.map((t: { session_id: string }) => t.session_id);
      expect(ids).toEqual(["T0"]);
    });

    it("a pending-open counter in any non-zero state (even an underflow) hides unregistered pages", async () => {
      targets.push({ targetId: "POPUP", type: "page", url: "about:blank", title: "" });
      getWarmSession(U)!.pendingPrivateOpens = -1;
      const ids = (await call("browser_tabs")).tabs.map((t: { session_id: string }) => t.session_id);
      expect(ids).toEqual(["T0"]);
      getWarmSession(U)!.pendingPrivateOpens = 0;
      expect((await call("browser_tabs")).tabs.map((t: { session_id: string }) => t.session_id)).toEqual(["T0", "POPUP"]);
    });

    it("an exception inside the privacy check hides the target", async () => {
      targets.push({ targetId: "POPUP", type: "page", url: "about:blank", title: "" });
      const s = getWarmSession(U)!;
      const realHas = s.privateIds.has.bind(s.privateIds);
      s.privateIds.has = (id: string) => { if (id === "POPUP") throw new Error("boom"); return realHas(id); };
      const ids = (await call("browser_tabs")).tabs.map((t: { session_id: string }) => t.session_id);
      expect(ids).toEqual(["T0"]);
    });

    it("an enumerator error propagates: nothing is listed and nothing is adopted", async () => {
      await closeTab(U, "T0");
      const client = await browserClient(getWarmSession(U)!);
      (client as unknown as { send: unknown }).send = vi.fn(async () => { throw new Error("cdp down"); });
      await expect(defaultTab(U)).rejects.toThrow();
      await expect(call("browser_tabs")).rejects.toThrow();
      expect(getWarmSession(U)!.defaultTabId).toBe("T0"); // unchanged, nothing adopted
    });
  });

  it("closePrivateTab closes the target; it counts toward the tab limit while open", async () => {
    const r = await openPrivateTab(U);
    if (!r.ok) throw new Error("open failed");
    expect(getWarmSession(U)!.privateTabs.size).toBe(1);
    expect(await closePrivateTab(U, "RECIPE")).toBe(true);
    expect(sent).toContainEqual({ method: "Target.closeTarget", params: { targetId: "RECIPE" } });
    expect(getWarmSession(U)!.privateTabs.size).toBe(0);
    expect(await closePrivateTab(U, "T0")).toBe(false); // agent tabs are not closable through it
  });
});
