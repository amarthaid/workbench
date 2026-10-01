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
  // Injected rather than imported: the registry stays free of the database.
  private isDisabled: (integration: string) => boolean = () => false;

  register(plugin: Plugin): void {
    this.plugins.set(plugin.integration.name, plugin);
    for (const tool of plugin.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * Hide disabled integrations from every lookup below. There are about 25 call
   * sites across the MCP tools, the REST routes and the portal API; filtering
   * here means none of them can forget to.
   */
  setDisabledPredicate(fn: (integration: string) => boolean): void {
    this.isDisabled = fn;
  }

  getPluginDir(name: string): string | undefined {
    return this.plugins.get(name)?.dir;
  }

  listToolsByIntegration(name: string): PluginTool[] {
    return this.isDisabled(name) ? [] : (this.plugins.get(name)?.tools ?? []);
  }

  getTool(name: string): PluginTool | undefined {
    const tool = this.tools.get(name);
    return tool && !this.isDisabled(tool.integration) ? tool : undefined;
  }

  getIntegration(name: string): Integration | undefined {
    return this.isDisabled(name) ? undefined : this.plugins.get(name)?.integration;
  }

  listIntegrations(): Integration[] {
    return this.listAllIntegrations().filter((i) => !this.isDisabled(i.name));
  }

  /** Every registered integration, disabled or not. For the admin Config tab only. */
  listAllIntegrations(): Integration[] {
    return Array.from(this.plugins.values()).map((p) => p.integration);
  }

  listTools(): PluginTool[] {
    return Array.from(this.tools.values()).filter((t) => !this.isDisabled(t.integration));
  }

  /** Built-in tools matching `query`, best first. See ./search. */
  searchTools(query: string): PluginTool[] {
    return rankTools(this.listTools(), query).map((r) => r.tool);
  }
}

export const registry = new Registry();
