import { ToolDefinition, Integration } from "@a-workbench/shared";
import { z } from "zod";
import { rankTools } from "./search";

export interface PluginTool extends ToolDefinition {
  // Narrow the base `unknown` to a real Zod schema so callers (e.g.
  // execute_tool) can `.safeParse` args without hand-rolled casts.
  inputSchema: z.ZodTypeAny;
  handler: (ctx: unknown, args: unknown) => Promise<unknown>;
}

export interface Plugin {
  integration: Integration;
  tools: PluginTool[];
  // Absolute path to the plugin's own directory — used to serve a bundled logo.
  dir?: string;
}

class Registry {
  private plugins = new Map<string, Plugin>();
  private tools = new Map<string, PluginTool>();

  register(plugin: Plugin): void {
    this.plugins.set(plugin.integration.name, plugin);
    for (const tool of plugin.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  getPluginDir(name: string): string | undefined {
    return this.plugins.get(name)?.dir;
  }

  listToolsByIntegration(name: string): PluginTool[] {
    return this.plugins.get(name)?.tools ?? [];
  }

  getTool(name: string): PluginTool | undefined {
    return this.tools.get(name);
  }

  getIntegration(name: string): Integration | undefined {
    return this.plugins.get(name)?.integration;
  }

  listIntegrations(): Integration[] {
    return Array.from(this.plugins.values()).map((p) => p.integration);
  }

  listTools(): PluginTool[] {
    return Array.from(this.tools.values());
  }

  /** Built-in tools matching `query`, best first. See ./search. */
  searchTools(query: string): PluginTool[] {
    return rankTools(this.listTools(), query).map((r) => r.tool);
  }
}

export const registry = new Registry();
