---
title: Core concepts
description: The nine words the rest of the documentation assumes you know.
---

## Integration

One third-party service, as workbench sees it: a name, a version, a declared auth
mode, an optional logo and categories, and an optional proxy base URL. `github`,
`slack`, `atlassian-jira`, `newrelic` are integrations. Sixteen ship on disk. Two
more (`browser`, `jots`) are built into the server.

An integration's auth mode decides everything about how it connects and how
credentials reach the outbound request. There are four: `oauth2`, `apikey`,
`cookie`, and `none`.

**Why it matters:** the integration name is what you pass to `connect()`, and what
appears in `list_integrations` alongside a per-user `connected` flag.

## Plugin

The on-disk form of an integration: a directory containing exactly two import
targets, `manifest.ts` (default-exporting the `Integration`) and `tools/index.ts`
(exporting the tools). Built-ins live in `packages/plugins`. Your own go in
`PLUGINS_DIR`.

Plugins load once at boot. There is no hot reload and no unload — the imports are
ESM-cached, so picking up an edit means restarting the server. A plugin that fails
to load is logged and skipped. The server still boots and every other plugin still
loads. A broken plugin therefore shows up as *silently absent from the catalog*
rather than as a crash.

**Why it matters:** "integration" is the concept, "plugin" is the thing you write
and mount. See [Build plugins](../plugins/index.md).

## Tool

One callable operation, with a globally unique slug, a description, its owning
integration, a Zod input schema, and a handler. `jira_create_issue`,
`github_list_prs`, `slack_send_message`. 194 ship across the 16 plugins.

Tool names are a flat global namespace across all loaded plugins, and registration
overwrites by name — a later plugin silently wins a collision. Prefix your tools
with your integration name.

**Why it matters:** a tool slug is the unit of everything. You search for it, you
fetch its schema by it, you execute it by it.

## Meta-tool

The nine tools the MCP endpoint actually advertises. They are the entire
`tools/list` response no matter how many plugin tools are loaded.

| Meta-tool | What it does |
|---|---|
| `search_tools` | Find tools by keyword over name and description. |
| `get_tool_schema` | Return one tool's argument schema as JSON Schema. |
| `execute_tools` | Run one or many tools, concurrently, results in order. |
| `whoami` | The authenticated workbench user — id and email. |
| `list_integrations` | Every integration with a per-user `connected` flag. |
| `connect` | Begin connecting an integration; returns a URL and a `connectionId`. |
| `wait_for_connection` | Block until that connection completes. |
| `get_auth_url` | Deprecated alias of `connect`. |
| `curl_session` | Mint a short-lived token for arbitrary API calls through the proxy. |

There is no singular `execute_tool`. A single tool is a one-element `executions`
array.

**Why it matters:** this is the whole contract between your agent and the server.
Everything else is reached by name through these nine.

## Registry

The in-memory index built at boot: one map of integrations by name, one map of
tools by name. `search_tools` reads it, `get_tool_schema` reads it, and
`execute_tools` resolves a slug through it to find the handler, the input schema,
and which integration's credential to inject.

**Why it matters:** it is why the tool list can stay at nine while the catalog
grows. It is also why tool names must be unique.

## Connection

A stored credential for one user and one integration — the row that makes
`connected: true`. What counts as connected depends on the auth mode: `none` is
always connected, `cookie` requires a stored bundle with at least one unexpired
cookie, everything else requires a stored token.

Connections are strictly per user. Two people using the same workbench have
separate Jira tokens and see separate connection states.

Distinct from the transient *pending connection* — the in-process record created by
`connect()` and polled by `wait_for_connection()`. It is `PENDING` only for the minutes
an OAuth handshake is in flight. Once terminal (`CONNECTED` or `EXPIRED`) it is kept for
another hour before a 60-second sweep prunes it. A wait that is still running can
therefore read the outcome.

**Why it matters:** `NOT_CONNECTED` from a tool call means this row is missing, and
the fix is `connect('<integration>')`.

## Browser session

A headless Chromium, one per user, with a persistent profile. It backs two
different things: capturing cookies for `cookie`-auth integrations, and the
`browser` integration's nine tools (`browser_navigate`, `browser_screenshot`,
`browser_click`, and so on).

There is one warm Chromium per user, and the two uses **share** it: capture and every
`browser_*` tool resolve the same session, so an agent can be driving the browser a user
is logging in through. The server kills idle sessions after `BROWSER_SESSION_TTL_SECONDS`
(default 300). The profile survives.

`BROWSER_SESSION_BUSY` is not a conflict between those two uses. It appears only while a
spawn for that user is still in flight, or when a profile reset is requested while the
profile is claimed — surfaced as 409 by `/api/browser-session/reset` and
`/api/browser-session/live-url`, and as 400 by the capture endpoints. See
[Browser sessions](../guides/browser-sessions.md).

A human can take over the live session: `browser_live_url` mints a signed,
short-lived URL into the portal, which streams the same browser over an
origin-gated CDP bridge — an SSE stream down, batched command POSTs back up.

**Why it matters:** it is how integrations without a usable OAuth app still work,
and how an agent hands control back to you mid-task.

## Curl session

A short-lived escape hatch. `curl_session(['github'])` mints a 15-minute token
scoped to the named integrations. The server forwards requests to
`<SERVER_PUBLIC_URL>/c/<integration>/<path>` carrying that token upstream, with the
user's real credential injected. It
covers provider endpoints no shipped tool wraps.

Only integrations whose manifest declares a `proxy` block accept it, and validation
is all-or-nothing: if any named integration is unknown, proxy-disabled, or not
connected, nothing is minted.

> [!DANGER] This is the highest-privilege thing in the product
> The token permits arbitrary GET/POST/PUT/PATCH/DELETE against the integration,
> including destructive writes, with the user's credential attached. Anything
> reachable with that credential is reachable with the token. The tool's own
> description instructs the agent to name the integrations and the intended action
> and wait for explicit approval before calling it.

## Jot

A static site the agent can deploy and host: `deploy_jot` returns a single-use
upload URL, you push a gzip tarball, and it is served at `/j/<name>/`. Names are
global and creator-locked, and a jot can be password-gated. `update_jot` patches a
live jot instead of replacing it, so a single data file can be refreshed on its own — and
it flips a jot's access, password, or CORS with no upload at all.
`list_jot_files` shows what a jot currently holds.

Jots are served on an opaque origin under a sandbox CSP, so a jot's JavaScript
cannot read app cookies or make credentialed same-origin calls to `/api` or `/mcp`.
One consequence is worth planning for: **by default a jot cannot fetch its own data
files** — it has to be self-contained, or opt into `cors: true`, which is public-jot
only and does not weaken the sandbox.

Defaults are 5 MiB decompressed, 1000 files, and a 5-minute upload token, all
configurable.

**Why it matters:** it is how an agent gives you a rendered artifact — a report, a
dashboard, a diff viewer — instead of a wall of JSON.
