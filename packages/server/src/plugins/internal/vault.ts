// The user vault as an internal registry plugin. Server source, not
// PLUGINS_DIR: the handlers reach into the vault store, and this is the one
// integration whose whole point is that the model never sees a value.
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import { listSecrets } from "../../vault/store";

export const VAULT_INTEGRATION_NAME = "vault";

const HOW_TO_REFERENCE =
  "To use a secret, write {{vault:NAME}} anywhere inside another tool's arguments (whole value or embedded, e.g. \"Bearer {{vault:api_token}}\"). The server swaps in the real value after your arguments leave the model and before the tool runs, and swaps it back out of the result. You never see the value, and you must never ask for it.";

// NOTE: there is deliberately no `vault_presign` tool here. Minting a
// one-time link is a read of the plaintext value one HTTP hop removed — an
// agent credential that can mint one can read every secret in the vault
// (list the names via vault_list, presign each, fetch each URL), which
// defeats the vault's one purpose. The only mint path is the portal-session-
// gated POST /api/vault/otl route (../../vault/routes.ts); keep it that way.

const tools: PluginTool[] = [
  {
    name: "vault_list",
    description: `List the secrets in the user's vault: names and descriptions only, never values. Secrets are added by the user in the portal; you cannot create or read them. ${HOW_TO_REFERENCE}`,
    integration: VAULT_INTEGRATION_NAME,
    effect: "read",
    inputSchema: z.object({}),
    handler: async (ctx: any) => {
      const secrets = await listSecrets(ctx.userId);
      // Explicit pick, not a spread: the model-facing shape is fixed here, so
      // a column added to `user_vaults` or to `listSecrets` later cannot widen
      // what the agent sees without someone editing this list.
      return {
        secrets: secrets.map((s) => ({
          name: s.name,
          description: s.description,
          updated_at: s.updated_at,
          last_used_at: s.last_used_at,
          reference: `{{vault:${s.name}}}`,
        })),
      };
    },
  },
];

export const vaultPlugin: Plugin = {
  integration: {
    name: VAULT_INTEGRATION_NAME,
    version: "1.0.0",
    auth: { type: "none" },
    displayName: "Vault",
    description:
      "Per-user encrypted secrets the agent can use but never read. Reference a secret as {{vault:NAME}} inside any tool's arguments, or mint a one-time URL to hand the value to a script.",
    categories: ["security"],
  },
  tools,
};
