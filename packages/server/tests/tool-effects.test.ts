import { describe, it, expect, beforeAll } from "vitest";
import { effectOf } from "@a-workbench/shared";
import { loadPlugins } from "../src/plugins/loader";
import { registry } from "../src/plugins/registry";

// Every built-in and internal integration. Listed here (not read from the
// loader) so a plugin that silently fails to load fails this test instead of
// shrinking the set it checks.
const BUILTIN_INTEGRATIONS = [
  "google-gmail",
  "google-drive",
  "google-sheets",
  "google-calendar",
  "google-gemini",
  "google-docs",
  "google-slides",
  "atlassian-jira",
  "atlassian-confluence",
  "atlassian-bitbucket",
  "asana",
  "github",
  "gitlab",
  "slack",
  "newrelic",
  "httpbin-cookie",
  "clevertap",
  "browser",
  "jots",
  "files",
  "vault",
  "spaces",
];

const ALLOWED = new Set(["read", "write", "destructive"]);

describe("effectOf", () => {
  it("returns the explicit label", () => {
    expect(effectOf({ effect: "read" })).toBe("read");
    expect(effectOf({ effect: "write" })).toBe("write");
    expect(effectOf({ effect: "destructive" })).toBe("destructive");
  });

  it("treats an unlabelled tool as destructive", () => {
    expect(effectOf({})).toBe("destructive");
    expect(effectOf({ effect: undefined })).toBe("destructive");
  });
});

describe("built-in tool effect labels", () => {
  beforeAll(async () => {
    await loadPlugins();
  });

  it("loads every built-in integration with at least one tool", () => {
    const empty = BUILTIN_INTEGRATIONS.filter((i) => registry.listToolsByIntegration(i).length === 0);
    expect(empty, `integrations with no tools loaded: ${empty.join(", ")}`).toEqual([]);
  });

  it("gives every built-in tool an explicit effect label", () => {
    const unlabelled: string[] = [];
    for (const integration of BUILTIN_INTEGRATIONS) {
      for (const tool of registry.listToolsByIntegration(integration)) {
        const effect = (tool as { effect?: unknown }).effect;
        if (typeof effect !== "string" || !ALLOWED.has(effect)) {
          unlabelled.push(`${tool.name} (${String(effect)})`);
        }
      }
    }
    expect(unlabelled, `tools without a valid effect label:\n${unlabelled.join("\n")}`).toEqual([]);
  });
});
