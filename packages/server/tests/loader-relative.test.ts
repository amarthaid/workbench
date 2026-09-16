import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";

// Guards the dynamic-loader fix for the container boot bug. PLUGINS_DIR is
// relative ("./plugins" by default + in .env); the loader must resolve it to an
// absolute path before import() (a relative path reaches Node's ESM resolver as
// a bare package specifier and throws ERR_MODULE_NOT_FOUND), and must skip dirs
// already shipped as built-ins (in the image PLUGINS_DIR == the built-in base
// dir, so every built-in would otherwise be re-imported). cwd is packages/server.
const REL_DIR = "./tmp-test-plugins";
const ABS_DIR = path.resolve(REL_DIR);
const CUSTOM = "tmp-relpath-plugin";
const BUILTIN = "github"; // a name in the built-in list

vi.mock("../src/config", () => ({
  config: { PLUGINS_DIR: REL_DIR },
}));


// Stub the internal plugins: their real handlers import browser-session →
// cookie → db, which needs full config these tests don't mock.
vi.mock("../src/plugins/internal/browser", () => ({
  browserPlugin: { integration: { name: "browser", version: "1.0.0", auth: { type: "none" } }, tools: [] },
}));
vi.mock("../src/plugins/internal/jots", () => ({
  jotsPlugin: { integration: { name: "jots", version: "1.0.0", auth: { type: "none" } }, tools: [] },
}));
vi.mock("../src/plugins/internal/vault", () => ({
  vaultPlugin: { integration: { name: "vault", version: "1.0.0", auth: { type: "none" } }, tools: [] },
}));

function writePlugin(name: string) {
  const toolsDir = path.join(ABS_DIR, name, "tools");
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(
    path.join(ABS_DIR, name, "manifest.ts"),
    `export default { name: "${name}", version: "9.9.9", auth: { type: "none" as const } };\n`
  );
  fs.writeFileSync(
    path.join(toolsDir, "index.ts"),
    `import { z } from "zod";
export const ping = {
  name: "${name}_ping",
  description: "ping",
  integration: "${name}",
  inputSchema: z.object({}),
  handler: async () => ({ ok: true }),
};
`
  );
}

beforeAll(() => {
  writePlugin(CUSTOM);
  writePlugin(BUILTIN); // collides with a built-in name on purpose
});

afterAll(() => {
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
});

describe("loadPlugins with a relative PLUGINS_DIR", () => {
  it("loads a custom plugin from a relative dir and skips built-in-named dirs", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { loadPlugins } = await import("../src/plugins/loader");
    const { registry } = await import("../src/plugins/registry");

    await loadPlugins();

    const names = registry.listIntegrations().map((i) => i.name);
    expect(names).toContain(CUSTOM);

    // The dynamic loop logs "Loaded plugin: <dir>" only for non-built-in dirs.
    // The built-in-named dir in PLUGINS_DIR must be skipped, not re-loaded.
    const dynamicLoads = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.startsWith("Loaded plugin:"));
    expect(dynamicLoads).toContain(`Loaded plugin: ${CUSTOM}`);
    expect(dynamicLoads).not.toContain(`Loaded plugin: ${BUILTIN}`);

    logSpy.mockRestore();
  });
});
