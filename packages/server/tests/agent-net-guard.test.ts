import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../src/config";
import { installBrowserNetGuard, isBlockedAgentRequest, __netGuard } from "../src/auth/agent-net-guard";

// Fake CDP client: records frames, lets the test fire events.
function fakeCdp() {
  const frames: Array<{ method: string; params: any; sessionId?: string }> = [];
  const listeners = new Map<string, Array<(p: any, s?: string) => void>>();
  let href = "about:blank";
  return {
    frames,
    setHref: (h: string) => { href = h; },
    emit: (method: string, params: any, sessionId?: string) => listeners.get(method)?.forEach((fn) => fn(params, sessionId)),
    cdp: {
      async send(method: string, params: any = {}, sessionId?: string) {
        frames.push({ method, params, sessionId });
        if (method === "Runtime.evaluate") return { result: { value: href } };
        return {};
      },
      on(method: string, fn: (p: any, s?: string) => void) {
        listeners.set(method, [...(listeners.get(method) ?? []), fn]);
        return () => {};
      },
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 10));

const saved = { allow: config.BROWSER_ALLOW_LOOPBACK, internal: config.INTERNAL_MCP_URL, resolve: __netGuard.resolve };
beforeEach(() => {
  config.BROWSER_ALLOW_LOOPBACK = false;
  config.INTERNAL_MCP_URL = undefined;
  __netGuard.cache.clear();
  __netGuard.resolve = async (host: string) => {
    if (host === "localtest.me" || host === "rebind.example.com") return ["127.0.0.1"];
    if (host === "v6loop.example.com") return ["::1"];
    return ["93.184.216.34"];
  };
});
afterEach(() => {
  config.BROWSER_ALLOW_LOOPBACK = saved.allow;
  config.INTERNAL_MCP_URL = saved.internal;
  __netGuard.resolve = saved.resolve;
});

describe("isBlockedAgentRequest", () => {
  it("refuses every loopback / unspecified spelling, on any port", async () => {
    for (const url of [
      "http://127.0.0.1:9222/json/list",
      "http://127.0.0.1:41234/json/close/ABC", // another user's chromium
      "http://127.1:9222/json",
      "http://2130706433:9222/json",
      "http://0x7f.1/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://127.5.6.7/",
      "http://0.0.0.0:9222/json",
      "http://0/",
      "http://[::1]:9222/json",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[0:0:0:0:0:ffff:7f00:1]/",
      "http://localhost:9222/",
      "http://LOCALHOST./",
      "http://app.localhost/",
      "ws://127.0.0.1:9222/devtools/browser/x",
      "http://localtest.me:9222/json/list", // resolves to loopback
      "http://v6loop.example.com/",
    ]) {
      expect(await isBlockedAgentRequest(url), url).toBe(true);
    }
  });

  it("lets public and private-network URLs through", async () => {
    expect(await isBlockedAgentRequest("https://example.com/")).toBe(false);
    expect(await isBlockedAgentRequest("https://example.com:9222/json/list")).toBe(false);
    expect(await isBlockedAgentRequest("http://10.0.0.5/")).toBe(false);
    expect(await isBlockedAgentRequest("data:text/html,hi")).toBe(false);
  });

  it("fails closed on what it cannot parse", async () => {
    expect(await isBlockedAgentRequest("http://[bad")).toBe(true);
    expect(await isBlockedAgentRequest(undefined)).toBe(true);
  });

  it("refuses the workbench server's own internal host, on any port", async () => {
    config.INTERNAL_MCP_URL = "http://workbench-internal.example.com:3000/mcp";
    expect(await isBlockedAgentRequest("http://workbench-internal.example.com:3000/api/admin")).toBe(true);
    expect(await isBlockedAgentRequest("http://workbench-internal.example.com:9090/metrics")).toBe(true);
  });

  it("the test-only opt-out allows loopback, but never in production", async () => {
    config.BROWSER_ALLOW_LOOPBACK = true;
    expect(await isBlockedAgentRequest("http://127.0.0.1:5000/login")).toBe(false);
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await isBlockedAgentRequest("http://127.0.0.1:5000/login")).toBe(true);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe("installBrowserNetGuard", () => {
  const hooks = () => {
    const priv = new Set<string>(["RECIPE"]);
    return { priv, hooks: { isPrivate: (id: string) => priv.has(id), markPrivate: (id: string) => { priv.add(id); } } };
  };
  const attach = (f: ReturnType<typeof fakeCdp>, sid: string, targetId: string, extra: Record<string, unknown> = {}, parent?: string) =>
    f.emit("Target.attachedToTarget", { sessionId: sid, targetInfo: { type: "page", targetId, url: "about:blank", ...extra }, waitingForDebugger: true }, parent);

  it("auto-attaches paused to every new target on the browser client", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    expect(f.frames).toContainEqual({
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId: undefined,
    });
  });

  it("an agent tab or popup is guarded on its own session before it is resumed", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    attach(f, "S1", "POPUP", { openerId: "AGENT" });
    await flush();
    expect(f.frames.filter((x) => x.sessionId === "S1").map((x) => x.method)).toEqual([
      "Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger",
    ]);
    expect(f.frames.find((x) => x.method === "Fetch.enable" && x.sessionId === "S1")!.params).toEqual({ patterns: [{ urlPattern: "*" }] });
  });

  it("fails a loopback request on any port, continues a public one", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    attach(f, "S1", "AGENT");
    await flush();
    f.emit("Fetch.requestPaused", { requestId: "R1", request: { url: "http://127.0.0.1:41234/json/list" } }, "S1");
    f.emit("Fetch.requestPaused", { requestId: "R2", request: { url: "https://example.com/" } }, "S1");
    await flush();
    expect(f.frames).toContainEqual({ method: "Fetch.failRequest", params: { requestId: "R1", errorReason: "BlockedByClient" }, sessionId: "S1" });
    expect(f.frames).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "R2" }, sessionId: "S1" });
    expect(f.frames.find((x) => x.method === "Fetch.continueRequest" && x.params.requestId === "R1")).toBeUndefined();
  });

  it("a redirect hop to loopback is failed", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    attach(f, "S1", "AGENT");
    await flush();
    // Fetch pauses each hop as its own request; the hop carries the Location target.
    f.emit("Fetch.requestPaused", { requestId: "R3", redirectedRequestId: "R2", request: { url: "http://0x7f.1:41234/json/close/T" } }, "S1");
    await flush();
    expect(f.frames).toContainEqual({ method: "Fetch.failRequest", params: { requestId: "R3", errorReason: "BlockedByClient" }, sessionId: "S1" });
  });

  it("an out-of-process iframe of a guarded page is guarded too", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    attach(f, "S1", "AGENT");
    await flush();
    f.emit("Target.attachedToTarget", { sessionId: "S1F", targetInfo: { type: "iframe", targetId: "F1" }, waitingForDebugger: true }, "S1");
    await flush();
    expect(f.frames.filter((x) => x.sessionId === "S1F").map((x) => x.method)).toEqual([
      "Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger",
    ]);
  });

  it("the private recipe tab, its popups and frames are not intercepted", async () => {
    const f = fakeCdp();
    const h = hooks();
    await installBrowserNetGuard(f.cdp, h.hooks);
    attach(f, "SR", "RECIPE");
    await flush();
    attach(f, "SP", "SSO-POPUP", { openerId: "RECIPE" });
    await flush();
    f.emit("Target.attachedToTarget", { sessionId: "SRF", targetInfo: { type: "iframe", targetId: "RF" }, waitingForDebugger: true }, "SR");
    await flush();
    for (const sid of ["SR", "SP", "SRF"]) {
      expect(f.frames.filter((x) => x.sessionId === sid).map((x) => x.method), sid).toEqual(["Runtime.runIfWaitingForDebugger"]);
    }
    expect(h.priv.has("SSO-POPUP")).toBe(true); // hidden from agents like the recipe tab
  });

  it("a recipe tab attached before it was known private is released and never blocked", async () => {
    const f = fakeCdp();
    const h = hooks();
    const guard = await installBrowserNetGuard(f.cdp, h.hooks);
    attach(f, "SL", "LATE");
    await flush();
    h.priv.add("LATE");
    await guard.release("LATE");
    expect(f.frames).toContainEqual({ method: "Fetch.disable", params: {}, sessionId: "SL" });
    f.emit("Fetch.requestPaused", { requestId: "R5", request: { url: "http://127.0.0.1:5000/login" } }, "SL");
    await flush();
    expect(f.frames).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "R5" }, sessionId: "SL" });
  });

  it("a page that cannot be guarded is closed, not resumed", async () => {
    const f = fakeCdp();
    const send = f.cdp.send;
    f.cdp.send = async (m: string, p: any = {}, s?: string) => {
      if (m === "Fetch.enable" && s === "S2") { f.frames.push({ method: m, params: p, sessionId: s }); throw new Error("no Fetch"); }
      return send(m, p, s);
    };
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    attach(f, "S2", "P2", { openerId: "AGENT" });
    await flush();
    expect(f.frames).toContainEqual({ method: "Target.closeTarget", params: { targetId: "P2" }, sessionId: undefined });
    expect(f.frames.find((x) => x.method === "Runtime.runIfWaitingForDebugger")).toBeUndefined();
  });

  it("an existing tab already showing a blocked URL is sent to about:blank", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, hooks().hooks);
    f.emit("Target.attachedToTarget", {
      sessionId: "S0", targetInfo: { type: "page", targetId: "T0", url: "http://127.0.0.1:41234/json/list" }, waitingForDebugger: false,
    });
    await flush();
    expect(f.frames).toContainEqual({ method: "Page.navigate", params: { url: "about:blank" }, sessionId: "S0" });
  });
});
