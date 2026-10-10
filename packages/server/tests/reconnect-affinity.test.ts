import { describe, it, expect, vi, afterEach } from "vitest";
import { registry } from "../src/plugins/registry";
import { config } from "../src/config";
import { needsBrowserAffinity, runWithBrowserAffinity, mayOwnBrowser } from "../src/auth/reconnect/affinity";

const origUrl = config.INTERNAL_MCP_URL;
afterEach(() => {
  vi.restoreAllMocks();
  (config as any).INTERNAL_MCP_URL = origUrl;
});

function stubRegistry() {
  vi.spyOn(registry, "getTool").mockImplementation((n: string) =>
    n === "acme_list" ? ({ integration: "acme" } as any) : n === "other_list" ? ({ integration: "other" } as any) : undefined);
  vi.spyOn(registry, "getIntegration").mockImplementation((n: string) =>
    n === "acme"
      ? ({ name: "acme", auth: { type: "cookie", session: { dead: { status: [401] } }, reconnect: { steps: [{ goto: "loginUrl" }] } } } as any)
      : ({ name: n, auth: { type: "cookie" } } as any));
}

describe("needsBrowserAffinity", () => {
  it("is true for browser_* tools", () => {
    expect(needsBrowserAffinity(undefined, "browser_click")).toBe(true);
  });
  it("is true when an execution targets a recipe integration", () => {
    stubRegistry();
    expect(needsBrowserAffinity([{ tool: "other_list" }, { tool: "acme_list" }])).toBe(true);
  });
  it("is false for integrations without a recipe", () => {
    stubRegistry();
    expect(needsBrowserAffinity([{ tool: "other_list" }])).toBe(false);
  });
});

describe("mayOwnBrowser", () => {
  it("is true in single-process mode", () => {
    (config as any).INTERNAL_MCP_URL = undefined;
    expect(mayOwnBrowser()).toBe(true);
  });
  it("in a cluster, only inside runWithBrowserAffinity", () => {
    (config as any).INTERNAL_MCP_URL = "http://internal:3000/mcp";
    expect(mayOwnBrowser()).toBe(false);
    expect(runWithBrowserAffinity(() => mayOwnBrowser())).toBe(true);
  });
});
