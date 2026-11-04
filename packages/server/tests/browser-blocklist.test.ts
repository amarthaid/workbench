import { describe, it, expect, afterEach } from "vitest";
import { hostMatchesBlocklist, isHostBlockedBy, normaliseBlockedDomain } from "../src/settings/browser-blocklist";
import { isBlockedAgentRequest, __netGuard } from "../src/auth/agent-net-guard";
import { resetSettingsForTest, setSettingsForTest } from "../src/settings/instance-settings";
import { browserPlugin } from "../src/plugins/internal/browser";

describe("normaliseBlockedDomain", () => {
  it.each([
    ["example.com", "example.com"],
    ["  Example.COM.  ", "example.com"],
    ["*.example.com", "*.example.com"],
    ["*.Bücher.example.", "*.xn--bcher-kva.example"],
    ["https://www.example.com/path?q=1", "www.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["93.184.216.34", "93.184.216.34"],
    ["[2001:db8::1]", "2001:db8::1"],
  ])("%j → %j", (raw, want) => {
    expect(normaliseBlockedDomain(raw)).toBe(want);
  });

  it.each(["", "com", "*.com", "*.93.184.216.34", "ads.*.example.com", "example.*", "*example.com", "**.example.com", "com", "localhost", "exa mple.com", "-bad.example.com", "a..b.com", "http://", "x".repeat(400)])(
    "rejects %j",
    (raw) => {
      expect(normaliseBlockedDomain(raw)).toBeNull();
    }
  );
});

describe("hostMatchesBlocklist", () => {
  const list = ["example.com", "93.184.216.34"];
  it("matches the domain and its subdomains", () => {
    expect(hostMatchesBlocklist("example.com", list)).toBe(true);
    expect(hostMatchesBlocklist("WWW.Example.com.", list)).toBe(true);
    expect(hostMatchesBlocklist("a.b.example.com", list)).toBe(true);
  });
  it("does not match a lookalike suffix or a parent", () => {
    expect(hostMatchesBlocklist("notexample.com", list)).toBe(false);
    expect(hostMatchesBlocklist("example.com.evil.net", list)).toBe(false);
    expect(hostMatchesBlocklist("com", list)).toBe(false);
  });
  it("a *. entry matches subdomains only, not the domain itself", () => {
    const wild = ["*.example.org"];
    expect(hostMatchesBlocklist("www.example.org", wild)).toBe(true);
    expect(hostMatchesBlocklist("a.b.example.org", wild)).toBe(true);
    expect(hostMatchesBlocklist("example.org", wild)).toBe(false);
    expect(hostMatchesBlocklist("example.org.", wild)).toBe(false);
    expect(hostMatchesBlocklist("notexample.org", wild)).toBe(false);
  });

  it("a plain entry next to its wildcard still blocks the domain", () => {
    expect(hostMatchesBlocklist("example.org", ["*.example.org", "example.org"])).toBe(true);
  });

  it("an IP entry matches that literal only", () => {
    expect(hostMatchesBlocklist("93.184.216.34", list)).toBe(true);
    expect(hostMatchesBlocklist("93.184.216.35", list)).toBe(false);
  });
});

describe("allow exceptions: the more specific entry wins, allow wins a tie", () => {
  const block = ["*.prod.example.com"];
  const allow = ["x.prod.example.com", "z.prod.example.com"];
  it("the example: allow x and z, block every other *.prod host", () => {
    expect(isHostBlockedBy("x.prod.example.com", block, allow)).toBe(false);
    expect(isHostBlockedBy("z.prod.example.com", block, allow)).toBe(false);
    expect(isHostBlockedBy("api.x.prod.example.com", block, allow)).toBe(false); // allow covers subdomains
    expect(isHostBlockedBy("y.prod.example.com", block, allow)).toBe(true);
    expect(isHostBlockedBy("a.b.prod.example.com", block, allow)).toBe(true);
    expect(isHostBlockedBy("prod.example.com", block, allow)).toBe(false); // *. never matched the apex
  });
  it("a more specific block inside an allowed host wins again", () => {
    expect(isHostBlockedBy("bad.x.prod.example.com", [...block, "bad.x.prod.example.com"], allow)).toBe(true);
    expect(isHostBlockedBy("ok.x.prod.example.com", [...block, "bad.x.prod.example.com"], allow)).toBe(false);
  });
  it("an allow entry less specific than the block does not lift it", () => {
    expect(isHostBlockedBy("ads.example.com", ["ads.example.com"], ["example.com"])).toBe(true);
    expect(isHostBlockedBy("www.example.com", ["ads.example.com"], ["example.com"])).toBe(false);
  });
  it("allow wins a tie at the same domain", () => {
    expect(isHostBlockedBy("example.com", ["example.com"], ["example.com"])).toBe(false);
    expect(isHostBlockedBy("www.example.com", ["*.example.com"], ["example.com"])).toBe(false);
  });
  it("allow alone blocks nothing", () => {
    expect(isHostBlockedBy("anything.example", [], ["x.prod.example.com"])).toBe(false);
  });
  it("an IP allow exception lifts an IP block", () => {
    expect(isHostBlockedBy("93.184.216.34", ["93.184.216.34"], ["93.184.216.34"])).toBe(false);
  });
});

describe("blocklist in the agent browser", () => {
  const savedResolve = __netGuard.resolve;
  afterEach(() => {
    resetSettingsForTest();
    __netGuard.resolve = savedResolve;
  });

  it("the network guard refuses a blocked host and its subdomains, before any DNS lookup", async () => {
    let lookups = 0;
    __netGuard.cache.clear();
    __netGuard.resolve = async () => {
      lookups += 1;
      return ["93.184.216.34"];
    };
    setSettingsForTest({ browser_blocked_domains: ["blocked.example"] });
    expect(await isBlockedAgentRequest("https://blocked.example/")).toBe(true);
    expect(await isBlockedAgentRequest("https://cdn.blocked.example/x.js")).toBe(true);
    expect(await isBlockedAgentRequest("wss://blocked.example/socket")).toBe(true);
    expect(await isBlockedAgentRequest("https://BLOCKED.example./")).toBe(true);
    expect(lookups).toBe(0);
    expect(await isBlockedAgentRequest("https://notblocked.example/")).toBe(false);
  });

  it("a *. entry blocks subdomains in the guard but leaves the domain itself", async () => {
    __netGuard.cache.clear();
    __netGuard.resolve = async () => ["93.184.216.34"];
    setSettingsForTest({ browser_blocked_domains: ["*.wild.example"] });
    expect(await isBlockedAgentRequest("https://cdn.wild.example/x.js")).toBe(true);
    expect(await isBlockedAgentRequest("https://wild.example/")).toBe(false);
  });

  it("the guard honours allow exceptions, but they never lift the loopback guard", async () => {
    __netGuard.cache.clear();
    __netGuard.resolve = async () => ["93.184.216.34"];
    setSettingsForTest({
      browser_blocked_domains: ["*.prod.example.com"],
      browser_allowed_domains: ["x.prod.example.com", "localhost", "127.0.0.1"],
    });
    expect(await isBlockedAgentRequest("https://x.prod.example.com/")).toBe(false);
    expect(await isBlockedAgentRequest("https://y.prod.example.com/")).toBe(true);
    expect(await isBlockedAgentRequest("http://localhost:41234/json/list")).toBe(true);
    expect(await isBlockedAgentRequest("http://127.0.0.1:41234/json/list")).toBe(true);
  });

  it("an empty list blocks nothing extra", async () => {
    __netGuard.resolve = async () => ["93.184.216.34"];
    expect(await isBlockedAgentRequest("https://allowed.example/")).toBe(false);
  });

  it("browser_navigate rejects a blocked URL with a clear message", () => {
    const nav = browserPlugin.tools.find((t) => t.name === "browser_navigate")!;
    setSettingsForTest({ browser_blocked_domains: ["blocked.example"] });
    const bad = nav.inputSchema.safeParse({ session_id: "s", url: "https://www.blocked.example/page" });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error)).toMatch(/blocked by the workbench administrator/);
    expect(nav.inputSchema.safeParse({ session_id: "s", url: "https://ok.example/" }).success).toBe(true);
  });
});
