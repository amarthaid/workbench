import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { registry } from "../src/plugins/registry";

const integration = {
  name: "acme-off",
  version: "1.0.0",
  displayName: "Acme Off",
  auth: { type: "oauth2" as const, authorizationUrl: "", tokenUrl: "", scopes: [] },
};

const tool = {
  name: "acme_off_search",
  description: "Search acme records",
  integration: "acme-off",
  inputSchema: z.object({}),
  handler: async () => ({}),
};

registry.register({ integration: integration as any, tools: [tool as any] });

afterEach(() => {
  registry.setDisabledPredicate(() => false);
});

const disabled = (names: string[]) => (name: string) => names.includes(name);

describe("registry with a disabled integration", () => {
  it("is fully visible while nothing is disabled", () => {
    expect(registry.getIntegration("acme-off")).toBeDefined();
    expect(registry.getTool("acme_off_search")).toBeDefined();
    expect(registry.listIntegrations().map((i) => i.name)).toContain("acme-off");
    expect(registry.listTools().map((t) => t.name)).toContain("acme_off_search");
    expect(registry.listToolsByIntegration("acme-off")).toHaveLength(1);
  });

  it("hides it from every lookup, including search", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    expect(registry.getIntegration("acme-off")).toBeUndefined();
    expect(registry.getTool("acme_off_search")).toBeUndefined();
    expect(registry.listIntegrations().map((i) => i.name)).not.toContain("acme-off");
    expect(registry.listTools().map((t) => t.name)).not.toContain("acme_off_search");
    expect(registry.listToolsByIntegration("acme-off")).toEqual([]);
    expect(registry.searchTools("search acme records").map((t) => t.name)).not.toContain("acme_off_search");
  });

  it("still lists it for the admin view", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    expect(registry.listAllIntegrations().map((i) => i.name)).toContain("acme-off");
  });

  it("brings it back when it is re-enabled", () => {
    registry.setDisabledPredicate(disabled(["acme-off"]));
    registry.setDisabledPredicate(disabled([]));
    expect(registry.getTool("acme_off_search")).toBeDefined();
    expect(registry.searchTools("search acme records").map((t) => t.name)).toContain("acme_off_search");
  });

  it("disabling one integration leaves the others alone", () => {
    registry.setDisabledPredicate(disabled(["some-other"]));
    expect(registry.getTool("acme_off_search")).toBeDefined();
  });
});
