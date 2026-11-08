---
title: Write your first plugin
description: Build a complete working plugin from an empty directory, load it into the server, connect it, and call its tool from an agent.
---

This walks through a real, shipped plugin end to end: `google-gemini`. It is the
smallest complete OAuth plugin in the repo — one manifest, one tool — and all
three of its files are short enough to read in full. Build the same shape in a
directory of your own and you have a working integration.

:::steps

### Create the directory

The directory name is the contract. It must equal `manifest.name`, and it also
determines the OAuth environment-variable prefix and the callback URL, so pick it
before you register anything with the provider.

```bash
mkdir -p /srv/awb-plugins/google-gemini/tools
```

Kebab-case in the directory name becomes upper snake in the env vars:
`google-gemini` → `GOOGLE_GEMINI_CLIENT_ID` / `GOOGLE_GEMINI_CLIENT_SECRET`.

### Write the manifest

`manifest.ts` default-exports an `Integration`. Only `name`, `version`, and
`auth` are required. The rest control how the integration appears in the portal,
and whether the [curl proxy](../guides/curl-session.md) is available for it.

```ts
// manifest.ts
export default {
  name: "google-gemini",
  version: "1.0.0",
  displayName: "Google Gemini",
  description: "Gemini generative AI models.",
  logo: "logo.svg",
  categories: ["google","ai"],
  auth: {
    type: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/generative-language.retriever"],
  },
  proxy: { baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
};
```

`logo` is either a bare filename resolved inside the plugin directory and served
at `GET /api/integrations/<name>/logo`, or a full `https://` URL used as-is. Omit
it and the portal renders a generic cog. Every field is covered in the
[manifest reference](manifest.md).

### Write the tool

A tool is a plain object. Five members matter: `name`, `description`,
`integration`, `inputSchema`, and `handler`. A sixth, `effect`, is optional but
every tool should set it (see [Label the side effect](#label-the-side-effect)).

```ts
// tools/gemini.ts
import { z } from "zod";

export const generateContent = {
  name: "google_gemini_generate",
  description: "Generate content with Google Gemini",
  integration: "google-gemini",
  effect: "read",
  inputSchema: z.object({
    prompt: z.string(),
    model: z.string().default("gemini-1.5-flash"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `https://generativelanguage.googleapis.com/v1beta/models/${args.model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: args.prompt }] }],
        }),
      }
    );
    return res.json();
  },
};
```

The handler calls `ctx.http`, never bare `fetch` — that is what attaches the
user's credential. See [the context API](context.md).

### Label the side effect

`effect` tells workbench what a call does to the outside world, so it can decide
whether the call runs silently or asks the user to confirm first. It takes one of
three values:

| `effect` | Meaning | Examples |
|---|---|---|
| `"read"` | Changes nothing. | list, get, search, download, fetch, status, query |
| `"write"` | Creates or edits something in a recoverable or additive way. | create an issue, add a comment, upload a file, create a draft, add a label, update a single field, trigger a CI run |
| `"destructive"` | Deletes, trashes, overwrites wholesale, merges, closes or cancels; sends or posts on the user's behalf; changes sharing or permissions; or is otherwise irreversible or outward-facing. | delete a page, trash a file, merge a pull request, send an email, post a Slack message, share a file |

Decide from what the handler does, not from the tool's name. When a tool sits
between `write` and `destructive`, label it `destructive`.

The field is optional so that older plugins keep loading, but **a tool without
`effect` is treated as `destructive`**: every call to it will need confirmation.
`search_tools` and `get_tool_schema` report the label to agents, and
`get_tool_schema` also returns it as MCP-style
`annotations: { readOnlyHint, destructiveHint }`.

### Export it from `tools/index.ts`

`tools/index.ts` is the only tools file the loader imports. A re-export barrel is
enough:

```ts
// tools/index.ts
export { generateContent } from "./gemini";
```

That is the whole plugin: three files.

### Point the server at it and restart

```bash
# .env
PLUGINS_DIR=/srv/awb-plugins
GOOGLE_GEMINI_CLIENT_ID=...
GOOGLE_GEMINI_CLIENT_SECRET=...
```

Register this redirect URI on the provider's OAuth app:

```
${SERVER_PUBLIC_URL}/api/auth/plugin/google-gemini/callback
```

Restart the server. On boot the log shows:

```
Loaded plugin: google-gemini
```

If it does not, look for `Failed to load plugin google-gemini:` — the load is
try/caught per plugin, so a broken import removes the integration from the
catalog without stopping the server.

### Connect it

Either open the portal and click Connect on the card, or drive it from the agent:

```
connect({ integration: "google-gemini" })
→ { url, connectionId }

wait_for_connection({ connectionId })
→ { status: "CONNECTED" }
```

`wait_for_connection` returns a `{ status }` of `CONNECTED`, `TIMEOUT`, or
`EXPIRED`, and defaults to a 300-second timeout. An unknown `connectionId` — or
one owned by another user, which returns the identical shape — comes back as
`{ error: "Unknown connectionId" }` instead, so handle that fourth case in any
loop.

### Call the tool

Tools are executed through the `execute_tools` meta-tool. There is no
single-execution variant — for one tool, pass a one-element array.

```json
{
  "executions": [
    {
      "tool": "google_gemini_generate",
      "args": { "prompt": "Summarise the CAP theorem in two sentences." }
    }
  ]
}
```

The response is a `results` array in the same order as `executions`. One tool
failing does not abort the others. Its entry carries an `error` instead of a
`result`.

To confirm the tool is registered before calling it:

```bash
curl -s -X POST $SERVER_PUBLIC_URL/mcp \
  -H "x-workbench-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"search_tools","arguments":{"query":"gemini"}}}'
```

:::

## What makes an export a tool

The loader does not read a registry file or a decorator. It iterates every export
of `tools/index.ts` and keeps the values that pass a duck-type check:

| Requirement | Checked by the loader |
|---|---|
| Is a non-null object | Yes |
| Has a `name` property | Yes |
| Has a `handler` that is a function | Yes |
| Has an `inputSchema` that is `instanceof z.ZodType` | Yes |
| Has a `description` | No — but `search_tools` reads it |
| Has an `integration` | No — but execution needs it |
| Has an `effect` | No, but an unlabelled tool is treated as `"destructive"` |

An export that fails any of the first four is silently ignored: helper functions,
constants, and types can live in the same barrel without trouble. An export that
passes them but omits `description` or `integration` **registers and then breaks
at runtime** — `integration` is what the executor uses to look up the auth
config and build the context, and `description` is what tool search matches on.
Always set all five.

> [!WARNING] Tool names are a flat global namespace
> The registry keys tools by `name` across all plugins and overwrites on
> collision. If your plugin exports a tool named `github_list_repos`, whichever
> plugin loads last wins, silently. Prefix every tool name with your
> integration's identity.

## `inputSchema` must be Zod, not JSON Schema

This is the single most common mistake. A JSON-Schema object fails the
`instanceof z.ZodType` check, so the export is not recognised as a tool at all
and your plugin loads with zero tools and no error message.

Zod is required because the schema is used two ways:

- **Validation.** Args are `safeParse`d against it before the handler runs, so
  `.default()` values are materialised and the handler sees a fully-populated
  object. A parse failure returns `{ error: "Invalid arguments for <tool>: …" }`
  and the handler is never called.
- **Publication.** `get_tool_schema` converts it with `zodToJsonSchema` so any
  MCP client can consume a portable JSON Schema without knowing about Zod.

```ts
inputSchema: z.object({          // correct
  query: z.string(),
  limit: z.number().default(10),
}),
```

```ts
inputSchema: {                   // wrong — the tool will not register
  type: "object",
  properties: { query: { type: "string" } },
},
```

## What the handler can assume

By the time your handler runs, the executor has already:

- confirmed the integration is connected, returning
  `{ error: "NOT_CONNECTED", integration, message }` to the agent if not
  (`auth.type: "none"` counts as always connected, `cookie` checks for live
  cookies, and everything else requires a stored token)
- validated and defaulted the args
- built the `ToolContext` for `(userId, tool.integration)`.

Handlers do not need to catch their own errors — a throw is caught and converted
to `{ error }` for that execution entry.

Audit logging and metrics do not cover the same ground:

| Outcome | Audit log | `tool_executions_total` / duration |
|---|---|---|
| Handler returned | Yes | Yes, `success="true"` |
| Handler threw | Yes | Yes, `success="false"` |
| `NOT_CONNECTED` early return | Yes | No |
| Invalid arguments early return | Yes | No |

The counters are incremented only around handler execution, so a burst of
`NOT_CONNECTED` results or schema-validation failures never appears in
`tool_executions_total`. Alert on the audit log, not that series, if you need to
catch those.

> [!NOTE] `ctx` is typed `any` in every shipped plugin
> `ToolContext` is declared in server-internal source and is not exported from
> `@workbench/shared`, so plugins type their handlers `(ctx: any, args: any)`.
> The [context reference](context.md) documents the shape you can rely on.
