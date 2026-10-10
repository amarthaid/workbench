import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../src/config";
import { installBrowserNetGuard, isBlockedAgentRequest, createDnsResolver, __netGuard } from "../src/auth/agent-net-guard";
import { isAgentNavigableUrl, registerDebugPort, unregisterDebugPort } from "../src/auth/browser-url";

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

const saved = { allow: config.BROWSER_ALLOW_LOOPBACK, internal: config.INTERNAL_MCP_URL, resolve: __netGuard.resolve, query: __netGuard.query };
beforeEach(() => {
  config.BROWSER_ALLOW_LOOPBACK = false;
  config.INTERNAL_MCP_URL = undefined;
  __netGuard.cache.clear();
  // Deterministic system files: no hosts entries, no search domains.
  __netGuard.hostsText = "";
  __netGuard.resolvConfText = "";
  __netGuard.query = saved.query;
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
  __netGuard.query = saved.query;
  __netGuard.hostsText = undefined;
  __netGuard.resolvConfText = undefined;
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

describe("fails closed, and the localhost allow-list", () => {
  const savedPorts = config.BROWSER_LOOPBACK_ALLOW_PORTS;
  const savedServerPort = config.PORT;
  afterEach(() => {
    config.BROWSER_LOOPBACK_ALLOW_PORTS = savedPorts;
    config.PORT = savedServerPort;
    unregisterDebugPort(41234);
    __netGuard.timeoutMs = 2_000;
  });

  it("a DNS error, or a DNS timeout, blocks (and is cached briefly)", async () => {
    let calls = 0;
    __netGuard.resolve = async () => { calls += 1; throw new Error("ENOTFOUND"); };
    expect(await isBlockedAgentRequest("https://nx.example.com/")).toBe(true);
    expect(await isBlockedAgentRequest("https://nx.example.com/again")).toBe(true);
    expect(calls).toBe(1); // negative result cached
    __netGuard.timeoutMs = 20;
    __netGuard.resolve = () => new Promise(() => {});
    expect(await isBlockedAgentRequest("https://slow.example.com/")).toBe(true);
  });

  it("caps concurrent DNS lookups", async () => {
    let inFlight = 0;
    let peak = 0;
    __netGuard.resolve = async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ["93.184.216.34"];
    };
    await Promise.all(Array.from({ length: 30 }, (_, i) => isBlockedAgentRequest(`https://h${i}.example.com/`)));
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("an unknown scheme is blocked; data:, blob:, about: are not network", async () => {
    expect(await isBlockedAgentRequest("ftp://example.com/")).toBe(true);
    expect(await isBlockedAgentRequest("file:///etc/passwd")).toBe(true);
    expect(await isBlockedAgentRequest("blob:https://example.com/x")).toBe(false);
    expect(await isBlockedAgentRequest("about:blank")).toBe(false);
  });

  it("BROWSER_LOOPBACK_ALLOW_PORTS opens a listed loopback port, in any environment", async () => {
    config.BROWSER_LOOPBACK_ALLOW_PORTS = [5173];
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(await isBlockedAgentRequest("http://localhost:5173/")).toBe(false);
      expect(await isBlockedAgentRequest("http://127.0.0.1:5173/src/main.ts")).toBe(false);
      expect(await isBlockedAgentRequest("http://localhost:5174/")).toBe(true);
      expect(await isBlockedAgentRequest("http://localhost/")).toBe(true); // port 80, not listed
      expect(isAgentNavigableUrl("http://localhost:5173/")).toBe(true);
      expect(isAgentNavigableUrl("http://localhost:5174/")).toBe(false);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it("a live chromium debug port and the server's own port stay refused even when listed", async () => {
    registerDebugPort(41234);
    config.PORT = "3000";
    config.BROWSER_LOOPBACK_ALLOW_PORTS = [41234, 3000];
    expect(await isBlockedAgentRequest("http://127.0.0.1:41234/json/list")).toBe(true);
    expect(await isBlockedAgentRequest("http://localhost:3000/api/admin/users")).toBe(true);
    expect(isAgentNavigableUrl("http://127.0.0.1:41234/json/list")).toBe(false);
    expect(isAgentNavigableUrl("http://localhost:3000/")).toBe(false);
    config.INTERNAL_MCP_URL = "http://localhost:3000/mcp";
    expect(await isBlockedAgentRequest("http://localhost:3000/mcp")).toBe(true);
  });

  it("a paused-request handler that throws fails the request", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, {
      isPrivate: () => { throw new Error("boom"); },
      markPrivate: () => {},
    });
    f.emit("Fetch.requestPaused", { requestId: "RX", request: { url: "https://example.com/" } }, "SX");
    await flush();
    expect(f.frames).toContainEqual({ method: "Fetch.failRequest", params: { requestId: "RX", errorReason: "BlockedByClient" }, sessionId: "SX" });
  });

  it("a request from a session the guard never set up is failed", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, { isPrivate: () => false, markPrivate: () => {} });
    f.emit("Fetch.requestPaused", { requestId: "RU", request: { url: "https://example.com/" } }, "UNKNOWN");
    await flush();
    expect(f.frames).toContainEqual({ method: "Fetch.failRequest", params: { requestId: "RU", errorReason: "BlockedByClient" }, sessionId: "UNKNOWN" });
  });

  for (const type of ["worker", "service_worker", "shared_worker", "other"]) {
    it(`a ${type} that cannot be guarded is closed and never resumed`, async () => {
      const f = fakeCdp();
      const send = f.cdp.send;
      f.cdp.send = async (m: string, p: any = {}, s?: string) => {
        if (m === "Fetch.enable" && s === "SW") { f.frames.push({ method: m, params: p, sessionId: s }); throw new Error("no Fetch"); }
        return send(m, p, s);
      };
      await installBrowserNetGuard(f.cdp, { isPrivate: () => false, markPrivate: () => {} });
      f.emit("Target.attachedToTarget", { sessionId: "SW", targetInfo: { type, targetId: "W1" }, waitingForDebugger: true }, "S1");
      await flush();
      expect(f.frames).toContainEqual({ method: "Target.closeTarget", params: { targetId: "W1" }, sessionId: undefined });
      expect(f.frames.find((x) => x.method === "Runtime.runIfWaitingForDebugger")).toBeUndefined();
    });
  }

  it("a dedicated worker (no Fetch domain) runs only under a guarded parent page", async () => {
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, { isPrivate: () => false, markPrivate: () => {} });
    f.emit("Target.attachedToTarget", { sessionId: "S1", targetInfo: { type: "page", targetId: "T1" }, waitingForDebugger: true });
    await flush();
    f.emit("Target.attachedToTarget", { sessionId: "SW1", targetInfo: { type: "worker", targetId: "W1" }, waitingForDebugger: true }, "S1");
    await flush();
    // its requests are paused on the parent's session; nothing to enable on its own
    expect(f.frames.filter((x) => x.sessionId === "SW1").map((x) => x.method)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  it("guard setup for targets that already exist is finished before install returns", async () => {
    const f = fakeCdp();
    const send = f.cdp.send;
    let enabled = false;
    f.cdp.send = async (m: string, p: any = {}, s?: string) => {
      if (m === "Target.setAutoAttach" && !s) {
        // chromium reports existing targets while handling the command
        f.emit("Target.attachedToTarget", { sessionId: "S0", targetInfo: { type: "page", targetId: "T0", url: "about:blank" }, waitingForDebugger: false });
      }
      if (m === "Fetch.enable" && s === "S0") { await new Promise((r) => setTimeout(r, 30)); enabled = true; }
      return send(m, p, s);
    };
    await installBrowserNetGuard(f.cdp, { isPrivate: () => false, markPrivate: () => {} });
    expect(enabled).toBe(true);
  });
});

describe("DNS limits are per session and every wait is bounded", () => {
  afterEach(() => {
    __netGuard.timeoutMs = 2_000;
  });
  const hangOrFast = () => {
    __netGuard.resolve = (host: string) =>
      host.startsWith("slow") ? new Promise<string[]>(() => {}) : Promise.resolve(["93.184.216.34"]);
  };

  it("session A flooding slow lookups does not delay session B", async () => {
    hangOrFast();
    __netGuard.timeoutMs = 1_000;
    const a = createDnsResolver();
    const b = createDnsResolver();
    const flood = Array.from({ length: 200 }, (_, i) => isBlockedAgentRequest(`https://slow${i}.example.com/`, a));
    const t = Date.now();
    expect(await isBlockedAgentRequest("https://fast.example.com/", b)).toBe(false);
    expect(Date.now() - t).toBeLessThan(200);
    expect(new Set(await Promise.all(flood))).toEqual(new Set([true])); // every flooded one failed closed
  });

  it("one session's negative result does not leak to another session", async () => {
    const a = createDnsResolver();
    const b = createDnsResolver();
    __netGuard.resolve = async () => { throw new Error("SERVFAIL"); };
    expect(await isBlockedAgentRequest("https://flaky.example.com/", a)).toBe(true);
    __netGuard.resolve = async () => ["93.184.216.34"];
    expect(await isBlockedAgentRequest("https://flaky.example.com/", b)).toBe(false);
  });

  it("queue overflow fails closed at once", async () => {
    hangOrFast();
    __netGuard.timeoutMs = 5_000;
    const a = createDnsResolver();
    const all = Array.from({ length: 200 }, (_, i) => {
      const t = Date.now();
      return isBlockedAgentRequest(`https://slow${i}.example.com/`, a).then((v) => ({ v, ms: Date.now() - t }));
    });
    const first = await Promise.race(all);
    expect(first.v).toBe(true);
    expect(first.ms).toBeLessThan(500); // an overflowed request did not wait for the 5 s deadline
  });

  it("a wait on another request's lookup of the same host is bounded by its own deadline", async () => {
    hangOrFast();
    __netGuard.timeoutMs = 300;
    const a = createDnsResolver();
    void isBlockedAgentRequest("https://slow-same.example.com/", a);
    const t = Date.now();
    expect(await isBlockedAgentRequest("https://slow-same.example.com/x", a)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("the paused-request path ends in fail or continue within the deadline, even if the decision hangs", async () => {
    __netGuard.timeoutMs = 200;
    __netGuard.resolve = () => new Promise<string[]>(() => {});
    const f = fakeCdp();
    await installBrowserNetGuard(f.cdp, { isPrivate: () => false, markPrivate: () => {} });
    f.emit("Target.attachedToTarget", { sessionId: "S1", targetInfo: { type: "page", targetId: "T1" }, waitingForDebugger: true });
    await flush();
    f.emit("Fetch.requestPaused", { requestId: "RH", request: { url: "https://hang.example.com/" } }, "S1");
    await new Promise((r) => setTimeout(r, 600));
    expect(f.frames).toContainEqual({ method: "Fetch.failRequest", params: { requestId: "RH", errorReason: "BlockedByClient" }, sessionId: "S1" });
  });
});

describe("the guard is at least as strict as chromium's own resolver", () => {
  // Fresh resolver per case: no cache carried over.
  const blocked = (url: string) => isBlockedAgentRequest(url, createDnsResolver());
  const dns = (answers: Record<string, { 4?: string[] | "ENODATA" | "ETIMEOUT"; 6?: string[] | "ENODATA" | "ETIMEOUT" }>) => {
    __netGuard.resolve = saved.resolve; // the real A + AAAA logic, over a fake query
    __netGuard.query = async (host: string, family: 4 | 6) => {
      const a = answers[host]?.[family];
      if (a === undefined) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
      if (typeof a === "string") throw Object.assign(new Error(a), { code: a });
      return a;
    };
  };

  it("a name /etc/hosts maps to loopback fails, though public DNS says otherwise", async () => {
    dns({ "devbox.example.com": { 4: ["93.184.216.34"], 6: "ENODATA" } });
    expect(await blocked("http://devbox.example.com/")).toBe(false);
    __netGuard.hostsText = "# comment\n127.0.0.1 localhost\n127.0.1.1   devbox.example.com devbox  # alias\n";
    expect(await blocked("http://devbox.example.com/")).toBe(true);
    expect(await blocked("http://DEVBOX.example.com./")).toBe(true);
  });

  it("any name that appears in /etc/hosts fails closed, whatever it maps to", async () => {
    dns({ "pod-7.example.com": { 4: ["93.184.216.34"], 6: "ENODATA" } });
    __netGuard.hostsText = "10.1.2.3 pod-7.example.com\n";
    expect(await blocked("http://pod-7.example.com/")).toBe(true);
  });

  it("an AAAA-only ::1 answer fails", async () => {
    dns({ "v6only.example.com": { 4: "ENODATA", 6: ["::1"] } });
    expect(await blocked("http://v6only.example.com/")).toBe(true);
  });

  it("a public A with a loopback AAAA fails", async () => {
    dns({ "mixed.example.com": { 4: ["93.184.216.34"], 6: ["::1"] } });
    expect(await blocked("http://mixed.example.com/")).toBe(true);
    dns({ "mixed4.example.com": { 4: ["93.184.216.34", "127.0.0.1"], 6: "ENODATA" } });
    expect(await blocked("http://mixed4.example.com/")).toBe(true);
  });

  it("an error on either family fails; NODATA for one family is just no records", async () => {
    dns({ "ipv4only.example.com": { 4: ["93.184.216.34"], 6: "ENODATA" } });
    expect(await blocked("http://ipv4only.example.com/")).toBe(false);
    dns({ "half.example.com": { 4: ["93.184.216.34"], 6: "ETIMEOUT" } });
    expect(await blocked("http://half.example.com/")).toBe(true);
  });

  it("a single-label name fails", async () => {
    dns({ intranet: { 4: ["10.0.0.9"], 6: "ENODATA" } });
    expect(await blocked("http://intranet/")).toBe(true);
    expect(await blocked("http://intranet./")).toBe(true);
  });

  it("a trailing-dot name is normalised before every check", async () => {
    dns({ "public.example.com": { 4: ["93.184.216.34"], 6: "ENODATA" }, "loop.example.com": { 4: ["127.0.0.1"], 6: "ENODATA" } });
    expect(await blocked("http://public.example.com./")).toBe(false);
    expect(await blocked("http://loop.example.com./")).toBe(true);
    expect(await blocked("http://localhost./")).toBe(true);
  });

  it("search-domain expansions (dots < ndots) are checked too", async () => {
    __netGuard.resolvConfText = "search corp.example.net\noptions ndots:5\n";
    dns({ "app.dev": { 4: ["93.184.216.34"], 6: "ENODATA" }, "app.dev.corp.example.net": { 4: ["127.0.0.1"], 6: "ENODATA" } });
    expect(await blocked("http://app.dev/")).toBe(true);
    __netGuard.resolvConfText = "search corp.example.net\n"; // ndots 1: absolute first, no expansion needed
    expect(await blocked("http://app.dev/")).toBe(false);
  });
});
