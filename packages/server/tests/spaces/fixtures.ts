import { z } from "zod";
import { registry, type Plugin } from "../../src/plugins/registry";
import { jotsPlugin } from "../../src/plugins/internal/jots";
import { spacesPlugin } from "../../src/plugins/internal/spaces";

// Synthetic external plugins for Space tests. `acme` needs no credential (so
// executeSingle runs it for real); `acme-oauth` uses OAuth and is never
// connected in tests.
export const handlers = {
  list: async (_ctx: unknown, args: any) => ({ items: ["a", "b"], echo: args }),
  remove: async () => ({ removed: true }),
  fail: async () => {
    throw new Error("upstream exploded");
  },
};

export const acmePlugin: Plugin = {
  integration: { name: "acme", version: "1.0.0", auth: { type: "none" }, displayName: "Acme CRM" } as any,
  tools: [
    { name: "acme_list_items", description: "List items", integration: "acme", effect: "read", inputSchema: z.object({ q: z.string().optional() }), handler: (c, a) => handlers.list(c, a) },
    { name: "acme_delete_item", description: "Delete an item", integration: "acme", effect: "destructive", inputSchema: z.object({ id: z.string() }), handler: () => handlers.remove() },
    { name: "acme_unlabelled", description: "No effect label", integration: "acme", inputSchema: z.object({}), handler: () => handlers.remove() },
    { name: "acme_fail", description: "Always fails", integration: "acme", effect: "read", inputSchema: z.object({}), handler: () => handlers.fail() },
  ],
};

export const acmeOauthPlugin: Plugin = {
  integration: {
    name: "acme-oauth",
    version: "1.0.0",
    auth: { type: "oauth2", authorizationUrl: "https://auth.example.com/a", tokenUrl: "https://auth.example.com/t", scopes: [] },
    displayName: "Acme OAuth",
  } as any,
  tools: [
    { name: "acmeo_list_things", description: "List things", integration: "acme-oauth", effect: "read", inputSchema: z.object({}), handler: async () => ({}) },
  ],
};

export function registerFixtures(): void {
  registry.register(acmePlugin);
  registry.register(acmeOauthPlugin);
  registry.register(jotsPlugin);
  registry.register(spacesPlugin);
}

export function spacesTool(name: string) {
  const t = spacesPlugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (userId: string, args: unknown) => t.handler({ userId }, args) as Promise<any>;
}
