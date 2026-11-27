import { z } from "zod";
import { registry, type Plugin } from "../../src/plugins/registry";
import { jotsPlugin } from "../../src/plugins/internal/jots";
import { spacesPlugin } from "../../src/plugins/internal/spaces";
import type { ToolContext } from "../../src/plugins/context";

// Synthetic external plugins for Space tests. `acme` needs no credential (so
// executeSingle runs it for real); `acme-oauth` uses OAuth, and a test seeds a
// token with storeToken when it needs one connected. `acmeo_whoami` returns the
// token it was given, which is how a test proves whose access ran.
export const handlers = {
  list: async (_ctx: unknown, args: any) => ({ items: ["a", "b"], echo: args }),
  remove: async () => ({ removed: true }),
  fail: async () => {
    throw new Error("upstream exploded");
  },
  setSecret: async () => ({ stored: true }),
  whoami: async (ctx: ToolContext) => ({ token: await ctx.getToken() }),
};

export const acmePlugin: Plugin = {
  integration: { name: "acme", version: "1.0.0", auth: { type: "none" }, displayName: "Acme CRM" } as any,
  tools: [
    { name: "acme_list_items", description: "List items", integration: "acme", effect: "read", inputSchema: z.object({ q: z.string().optional() }), handler: (c, a) => handlers.list(c, a) },
    { name: "acme_delete_item", description: "Delete an item", integration: "acme", effect: "destructive", inputSchema: z.object({ id: z.string() }), handler: () => handlers.remove() },
    { name: "acme_update_item", description: "Update an item", integration: "acme", effect: "write", inputSchema: z.object({ id: z.string() }), handler: () => handlers.remove() },
    { name: "acme_unlabelled", description: "No effect label", integration: "acme", inputSchema: z.object({}), handler: () => handlers.remove() },
    { name: "acme_fail", description: "Always fails", integration: "acme", effect: "read", inputSchema: z.object({}), handler: () => handlers.fail() },
    { name: "acme_set_secret", description: "Rewrite the stored credential", integration: "acme", effect: "write", delegable: false, inputSchema: z.object({}), handler: () => handlers.setSecret() },
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
    { name: "acmeo_whoami", description: "Echo the token", integration: "acme-oauth", effect: "read", inputSchema: z.object({}), handler: (c) => handlers.whoami(c as ToolContext) },
  ],
};

// Cookie auth with a dead-session rule and a reconnect recipe: a call that
// finds the session dead would normally re-log in through the user's browser.
export const acmeCookiePlugin: Plugin = {
  integration: {
    name: "acme-cookie",
    version: "1.0.0",
    auth: {
      type: "cookie",
      loginUrl: "https://app.example.com/login",
      targetDomain: "app.example.com",
      cookieDomains: ["app.example.com"],
      session: { dead: { status: [401] } },
      reconnect: { steps: [{ goto: "loginUrl" }] },
    },
    displayName: "Acme Cookie",
  } as any,
  tools: [
    {
      name: "acmec_me",
      description: "Read the signed-in account",
      integration: "acme-cookie",
      effect: "read",
      inputSchema: z.object({}),
      handler: async (c) => {
        const res = await (c as ToolContext).http("https://app.example.com/api/me");
        if (!res.ok) throw new Error(`upstream ${res.status}`);
        return { ok: true };
      },
    },
  ],
};

export function registerFixtures(): void {
  registry.register(acmePlugin);
  registry.register(acmeOauthPlugin);
  registry.register(acmeCookiePlugin);
  registry.register(jotsPlugin);
  registry.register(spacesPlugin);
}

export function spacesTool(name: string) {
  const t = spacesPlugin.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (userId: string, args: unknown) => t.handler({ userId }, args) as Promise<any>;
}
