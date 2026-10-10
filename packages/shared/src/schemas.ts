import { z } from "zod";
import type { CookieConfig } from "./types";
import { validateCookieRecipe } from "./reconnect";

export const searchToolsSchema = z.object({
  query: z.string().min(1),
});

export const getToolSchema = z.object({
  tool: z.string(),
});

export const getAuthUrlSchema = z.object({
  integration: z.string(),
});

export const integrationSchema = z.object({
  name: z.string(),
  version: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  logo: z.string().optional(),
  categories: z.array(z.string()).optional(),
  auth: z.union([
    z.object({
      type: z.literal("oauth2"),
      authorizationUrl: z.string().url(),
      tokenUrl: z.string().url(),
      scopes: z.array(z.string()),
    }),
    z.object({
      type: z.literal("apikey"),
      headerName: z.string(),
      allowedHosts: z.array(z.string()).optional(),
      fields: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          description: z.string().optional(),
          placeholder: z.string().optional(),
          secret: z.boolean().optional(),
          options: z.array(z.string()).optional(),
          optional: z.boolean().optional(),
          multiline: z.boolean().optional(),
        })
      ),
    }),
    z.object({
      type: z.literal("cookie"),
      loginUrl: z.string().url(),
      targetDomain: z.string(),
      cookieDomains: z.array(z.string()).optional(),
      session: z.object({
        probe: z.object({ path: z.string().startsWith("/"), alive: z.array(z.number().int()).min(1) }).optional(),
        dead: z.object({ status: z.array(z.number().int()).min(1), redirectTo: z.string().optional() }),
      }).optional(),
      reconnect: z.object({
        credentials: z.array(z.object({
          key: z.string().regex(/^[a-z0-9_]+$/),
          label: z.string(),
          secret: z.boolean().optional(),
        })).optional(),
        allowHosts: z.array(z.string()).optional(),
        steps: z.array(z.union([
          z.object({ goto: z.string() }).strict(),
          z.object({ click: z.string(), optional: z.boolean().optional(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ fill: z.string(), value: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ press: z.string() }).strict(),
          z.object({ waitFor: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
          z.object({ waitUrl: z.string(), timeoutMs: z.number().int().positive().optional() }).strict(),
        ])),
        timeoutMs: z.number().int().positive().optional(),
      }).optional(),
    }).superRefine((auth, ctx) => {
      for (const message of validateCookieRecipe(auth as CookieConfig)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["reconnect"] });
      }
    }),
    z.object({
      type: z.literal("none"),
    }),
  ]),
});
