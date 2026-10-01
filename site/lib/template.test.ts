import { describe, it, expect } from "vitest";
import { renderPage, fillReplay } from "./template";

const data = {
  inventory: { integrations: [{ name: "github", displayName: "GitHub", description: "Code hosting", logoSvg: "<svg id='gh'></svg>", toolCount: 12 }], totals: { integrations: 1, tools: 12, metaTools: 9 } },
  replay: [{ prompt: "hello" }, { call: { tool: "search_tools", args: { query: "x" } } }, { result: "ok" }],
  docsUrl: "https://example.com/docs", repoUrl: "https://example.com/repo", image: "og-1200x630.png",
  shots: { apps: "shots/apps.png", connect: "shots/connect.png", result: "shots/result.png" },
  logoUrls: ["logos/github.svg"],
};

describe("renderPage", () => {
  const html = renderPage(data);
  it("opens with the headline and the docker one-liner", () => {
    expect(html).toContain("One endpoint. Every tool your agent needs.");
    expect(html).toContain("docker run");
    expect(html).toContain('data-copy="docker run');
  });
  it("prints live counts, never typed numbers", () => {
    expect(html).toContain("1 integration");
    expect(html).toContain("12 tools");
    expect(html).toContain("9 meta-tools");
  });
  it("inlines every integration logo with its name", () => {
    expect(html).toContain("<svg id='gh'></svg>");
    expect(html).toContain("GitHub");
  });
  it("embeds the replay for the terminal script and the portal shots", () => {
    expect(html).toContain('id="replay-data"');
    expect(html).toContain("search_tools");
    expect(html).toContain('src="shots/apps.png"');
  });
  it("fills a {{tools}} placeholder in the replay with the live count", () => {
    const filled = fillReplay([{ result: "a · b · c (3 of {{tools}})" }], data.inventory.totals);
    expect(renderPage({ ...data, replay: filled })).toContain("3 of 12");
  });
  it("has sections in layout B order", () => {
    const ids = [...html.matchAll(/<section[^>]*id="([a-z-]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["hero", "integrations", "demo", "pillars", "contribute", "teams", "cta"]);
  });
  it("shows the live integration count in the contribute headline", () => {
    expect(html).toContain("1 integration today. Yours next.");
  });
  it("describes the audit trail in the teams section", () => {
    expect(html).toContain("One audit trail");
  });
  it("links docs and the repo, carries the OG image, and hosts a swarm canvas", () => {
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('href="https://example.com/repo"');
    expect(html).toContain('property="og:image" content="og-1200x630.png"');
    expect(html).toContain('<canvas id="swarm"');
  });
  it("resolves the hero docs link relative to a same-domain docs path", () => {
    const relative = renderPage({ ...data, docsUrl: "docs/" });
    expect(relative).toContain('href="docs/start/quickstart.html"');
  });
  it("passes the integration logo URLs into the swarm script", () => {
    expect(html).toContain('"logos":["logos/github.svg"]');
  });
  it("keeps the logo ambient band clear of the copy column", () => {
    expect(html).toContain('"logoZone":[0.46,1,0,0.72]');
  });
});
