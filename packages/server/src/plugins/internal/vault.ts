// The user vault as an internal registry plugin. Server source, not
// PLUGINS_DIR: the handlers reach into the vault store, and this is the one
// integration whose whole point is that the model never sees a value.
import { z } from "zod";
import { Plugin, PluginTool } from "../registry";
import { listSecrets, VaultError } from "../../vault/store";
import { mintOtl, OTL_DEFAULT_TTL_SECONDS, OTL_MAX_TTL_SECONDS } from "../../vault/otl";

export const VAULT_INTEGRATION_NAME = "vault";

const HOW_TO_REFERENCE =
  "To use a secret, write {{vault:NAME}} anywhere inside another tool's arguments (whole value or embedded, e.g. \"Bearer {{vault:api_token}}\"). The server swaps in the real value after your arguments leave the model and before the tool runs, and swaps it back out of the result. You never see the value, and you must never ask for it.";

function fail(e: unknown): { error: string } {
  if (e instanceof VaultError) return { error: e.code };
  throw e;
}

const tools: PluginTool[] = [
  {
    name: "vault_list",
    description: `List the secrets in the user's vault: names and descriptions only, never values. Secrets are added by the user in the portal; you cannot create or read them. ${HOW_TO_REFERENCE}`,
    integration: VAULT_INTEGRATION_NAME,
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
  {
    name: "vault_presign",
    description: `Mint a one-time URL for a secret's value, for when the value is needed OUTSIDE workbench — a local script, an .env file, a CI job. Fetch it from where the value is needed and write it straight to a file or a variable, never to your output: curl -fsS "$URL" -o ./secret.txt   or   TOKEN=$(curl -fsS "$URL"). The URL works exactly once and expires after ttl_seconds (default ${OTL_DEFAULT_TTL_SECONDS}, max ${OTL_MAX_TTL_SECONDS}); if the fetch fails, mint another. Do not fetch it yourself and do not print what it returns. For use inside another workbench tool, do not presign — write {{vault:NAME}} in that tool's arguments instead.`,
    integration: VAULT_INTEGRATION_NAME,
    inputSchema: z.object({
      name: z.string(),
      ttl_seconds: z.number().int().positive().max(OTL_MAX_TTL_SECONDS).optional(),
    }),
    handler: async (ctx: any, args: any) => {
      try {
        const m = await mintOtl(ctx.userId, args.name, args.ttl_seconds);
        return { url: m.url, expires_at: new Date(m.expiresAt).toISOString() };
      } catch (e) {
        return fail(e);
      }
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
