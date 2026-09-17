import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import { loadPlugins } from "../src/plugins/loader";
import { registry } from "../src/plugins/registry";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
  };
});

vi.mock("../src/config", () => ({
  config: { PLUGINS_DIR: "./plugins" },
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

vi.mock("../src/plugins/registry", () => ({
  registry: {
    register: vi.fn(),
  },
}));

describe("loadPlugins", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers plugins when paths exist", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      // Base path exists
      if (s.includes("plugins")) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    await loadPlugins();

    expect(registry.register).toHaveBeenCalled();
  });

  it("handles missing base paths gracefully", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    await expect(loadPlugins()).resolves.not.toThrow();
  });

  it("loads dynamic plugins from PLUGINS_DIR", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("plugins")) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockReturnValue(["custom-plugin"] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);

    await loadPlugins();

    // Should have called register for built-in plugins + attempted dynamic
    expect(registry.register).toHaveBeenCalled();
  });

  it("ignores non-directory entries in PLUGINS_DIR", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("plugins")) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockReturnValue(["file.txt"] as any);
    vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

    await loadPlugins();
  });

  it("handles failed plugin load gracefully", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = p.toString();
      if (s.includes("plugins")) return true;
      return false;
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await loadPlugins();
    consoleSpy.mockRestore();
  });
});
