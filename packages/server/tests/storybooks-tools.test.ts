import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    if (String(host).includes("rebind")) return [{ address: "10.0.0.8", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  }),
}));

import { clearStorybooksCache, storybookUrl } from "../../plugins/storybooks/tools/client";
import {
  compareVersions,
  getComponentConfig,
  listStories,
  mapFigma,
  previewStory,
} from "../../plugins/storybooks/tools/index";

const INDEX = {
  v: 5,
  entries: {
    "components-button--primary": {
      id: "components-button--primary",
      title: "Components/Button",
      name: "Primary",
      importPath: "./src/Button.stories.tsx",
      type: "story",
      tags: ["autodocs"],
      componentPath: "./src/Button.tsx",
    },
    "components-button--docs": {
      id: "components-button--docs",
      title: "Components/Button",
      name: "Docs",
      importPath: "./src/Button.stories.tsx",
      type: "docs",
      tags: ["autodocs"],
    },
  },
};

const IFRAME = `<html><script src="./assets/iframe-abc.js"></script><link href="./tokens.css" rel="stylesheet"></html>`;
const BUNDLE = `"./src/Button.stories.tsx":async()=>x((()=>import("./Button.stories-abc.js")))`;
const CHUNK = `argTypes:{variant:{control:"select",options:["primary","secondary"],description:"Visual style"}},Story={args:{variant:"primary"}}`;

function body(text: string, status = 200) {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    arrayBuffer: async () => copy,
  };
}

function ctx(config: Record<string, unknown>, token = "tok-abc") {
  return {
    userId: "user-1",
    getToken: async () => token,
    getConfig: () => config,
    http: async () => {
      throw new Error("ctx.http must not be used");
    },
  };
}

describe("storybooks", () => {
  const calls: { url: string; headers: Headers }[] = [];

  beforeEach(() => {
    clearStorybooksCache();
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Headers }) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        const href = String(url);
        if (href.includes("other.example")) return body(JSON.stringify({ v: 5, entries: {} }));
        if (href.includes("index.json")) return body(JSON.stringify(INDEX));
        if (href.includes("iframe.html")) return body(IFRAME);
        if (href.includes("iframe-abc.js")) return body(BUNDLE);
        if (href.includes("Button.stories-abc.js")) return body(CHUNK);
        if (href.includes("tokens.css")) return body(":root { --color-primary: #112233; --space-2: 8px; }");
        return body("missing", 404);
      })
    );
  });

  it("lists stories from index.json and sends the bearer token only to that origin", async () => {
    const result = await listStories.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "bearer" }),
      {}
    );
    expect(result.total).toBe(2);
    expect(result.stories[0].title).toBe("Components/Button");
    expect(calls[0]?.url).toContain("https://sb.example.com/storybook/index.json");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer tok-abc");
  });

  it("rejects a private Storybook URL before any request", async () => {
    await expect(
      listStories.handler(ctx({ baseUrl: "http://10.0.0.5", authType: "none" }), {})
    ).rejects.toThrow(/not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a hostname that resolves to a private address", async () => {
    await expect(
      listStories.handler(ctx({ baseUrl: "https://rebind.example", authType: "none" }), {})
    ).rejects.toThrow(/private address/);
    expect(calls).toHaveLength(0);
  });

  it("reads argTypes from the compiled story chunk", async () => {
    const result = await getComponentConfig.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "bearer" }),
      { component: "Button" }
    );
    expect(result.name).toBe("Button");
    expect(result.argTypes[0]).toMatchObject({ name: "variant", control: "select", options: ["primary", "secondary"] });
    expect(result.presets[0].args).toEqual({ variant: "primary" });
  });

  it("keeps the preview URL on the connected origin", async () => {
    const result = await previewStory.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "none" }),
      { storyId: "components-button--primary", args: { variant: "primary" } }
    );
    const preview = new URL(result.previewUrl);
    expect(preview.origin).toBe("https://sb.example.com");
    expect(preview.pathname).toBe("/storybook/iframe.html");
    expect(preview.searchParams.get("id")).toBe("components-button--primary");
    expect(preview.searchParams.get("args")).toContain("variant:primary");
  });

  it("does not send the stored cookie to the other deployment", async () => {
    await compareVersions.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "cookie" }, "session=abc"),
      { otherUrl: "https://other.example/sb" }
    );
    const connected = calls.find((call) => call.url.includes("sb.example.com"));
    const other = calls.find((call) => call.url.includes("other.example"));
    expect(connected?.headers.get("cookie")).toBe("session=abc");
    expect(other?.headers.get("cookie")).toBeNull();
    expect(other?.headers.get("authorization")).toBeNull();
  });

  it("maps a Figma name onto the Storybook component and prefers an explicit node mapping", async () => {
    const byName = await mapFigma.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "none" }),
      { figmaName: "Button / Primary" }
    );
    expect(byName.match).toMatchObject({
      source: "name",
      storybookComponent: "Components/Button",
      storyId: "components-button--primary",
      suggestedProps: { variant: "primary" },
    });

    const mappings = JSON.stringify([
      {
        figmaNodeId: "12:34",
        storybookComponent: "Components/Button",
        storyId: "components-button--primary",
        props: { variant: "secondary" },
      },
    ]);
    const byNode = await mapFigma.handler(
      ctx({ baseUrl: "https://sb.example.com/storybook", authType: "none", figmaMappings: mappings }),
      { figmaUrl: "https://www.figma.com/design/abc/File?node-id=12-34" }
    );
    expect(byNode.match).toMatchObject({
      source: "mapping",
      confidence: "exact",
      storyId: "components-button--primary",
      suggestedProps: { variant: "secondary" },
    });
  });

  it("refuses a path that leaves the Storybook base", () => {
    expect(() => storybookUrl("https://sb.example.com/storybook", "../secret")).toThrow(/not allowed/);
    expect(storybookUrl("https://sb.example.com/storybook", "index.json")).toBe(
      "https://sb.example.com/storybook/index.json"
    );
  });
});
