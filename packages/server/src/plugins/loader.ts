import fs from "fs";
import path from "path";
import { z } from "zod";
import { config } from "../config";
import { registry, PluginTool } from "./registry";
import { browserPlugin } from "./internal/browser";
import { jotsPlugin } from "./internal/jots";
import { filesPlugin } from "./internal/files";
import { vaultPlugin } from "./internal/vault";

const builtinPlugins = [
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
];

function findPluginsBasePath(): string | undefined {
  const candidates = [
    path.resolve(process.cwd(), "../plugins"),
    path.resolve(process.cwd(), "../../plugins"),
    path.resolve(process.cwd(), "plugins"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function isTool(v: unknown): v is PluginTool {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    "name" in o &&
    "handler" in o &&
    typeof o.handler === "function" &&
    o.inputSchema instanceof z.ZodType
  );
}

// A plugin's tools are named exports when the module graph stays ESM, but a
// CJS-transpiled plugin arrives as a namespace holding `default` (and
// `module.exports`) with the tools nested inside. The server is compiled to CJS
// in the container while plugins load from .ts through tsx, so that is the
// shape it actually sees — every directory-loaded plugin reported zero tools
// because only the top level was searched. unwrapDefault already handles the
// same shape for the manifest.
export function filterTools(module: Record<string, unknown>): PluginTool[] {
  const found = new Map<string, PluginTool>();
  const visit = (candidate: unknown, depth = 0) => {
    if (typeof candidate !== "object" || candidate === null || depth > 2) return;
    for (const v of Object.values(candidate as Record<string, unknown>)) {
      if (isTool(v)) found.set(v.name, v);
    }
    const o = candidate as Record<string, unknown>;
    visit(o.default, depth + 1);
    visit(o["module.exports"], depth + 1);
  };
  visit(module);
  return Array.from(found.values());
}

function unwrapDefault<T>(mod: Record<string, unknown>): T {
  const d = mod.default as Record<string, unknown> | undefined;
  if (d && "default" in d) return d.default as T;
  return mod.default as T;
}

async function loadBuiltin(pluginName: string, basePath: string): Promise<void> {
  const pluginPath = path.join(basePath, pluginName);

  try {
    const manifestMod = await import(path.join(pluginPath, "manifest.ts"));
    const toolsMod = await import(path.join(pluginPath, "tools/index.ts"));

    registry.register({
      integration: unwrapDefault(manifestMod),
      tools: filterTools(toolsMod),
      dir: pluginPath,
    });
  } catch (e) {
    console.error(`Failed to load built-in plugin ${pluginName}:`, e);
  }
}

export async function loadPlugins(): Promise<void> {
  registerInternalPlugins();

  const basePath = findPluginsBasePath();
  if (basePath) {
    for (const name of builtinPlugins) {
      await loadBuiltin(name, basePath);
    }
  }

  // Dynamically load custom plugins from PLUGINS_DIR. Resolve to an absolute
  // path first: a relative dir (the default "./plugins", and what ships in the
  // container image) would otherwise reach import() as a bare specifier — Node's
  // ESM resolver reads "plugins/slack/manifest.ts" as package "plugins" and
  // throws ERR_MODULE_NOT_FOUND. See findings/2026-05-30-relative-plugins-dir-import.
  const pluginsDir = path.resolve(config.PLUGINS_DIR);
  if (!fs.existsSync(pluginsDir)) return;

  const dirs = fs.readdirSync(pluginsDir).filter((d) =>
    fs.statSync(path.join(pluginsDir, d)).isDirectory()
  );

  for (const dir of dirs) {
    // In the container image PLUGINS_DIR and the built-in base path are the same
    // directory, so every built-in dir would be re-imported here. The built-in
    // loop already registered them; skip to avoid redundant loads.
    if (builtinPlugins.includes(dir)) continue;
    // register() overwrites by name — never let a disk plugin shadow an
    // internal capability.
    if (internalNames.includes(dir)) {
      console.error(`Skipping plugin dir "${dir}": name reserved for internal plugin`);
      continue;
    }
    const pluginPath = path.join(pluginsDir, dir);
    try {
      const manifestMod = await import(path.join(pluginPath, "manifest.ts"));
      const toolsMod = await import(path.join(pluginPath, "tools/index.ts"));
      registry.register({
        integration: unwrapDefault(manifestMod),
        tools: filterTools(toolsMod),
        dir: pluginPath,
      });
      console.log(`Loaded plugin: ${dir}`);
    } catch (e) {
      console.error(`Failed to load plugin ${dir}:`, e);
    }
  }

}

const internalNames = [
  browserPlugin.integration.name,
  jotsPlugin.integration.name,
  filesPlugin.integration.name,
  vaultPlugin.integration.name,
];

// Internal capabilities (auth type "none") whose handlers reach into server
// modules (browser-session, jots store, the file workspace, the vault store)
// — deliberately NOT part of the plugin ToolContext, so third-party plugins
// can never drive the user's browser or touch those filesystems.
export function registerInternalPlugins(): void {
  registry.register(browserPlugin);
  registry.register(jotsPlugin);
  registry.register(filesPlugin);
  registry.register(vaultPlugin);
}
