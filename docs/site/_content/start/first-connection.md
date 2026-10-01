---
title: Your first integration
description: Connect GitHub and run a tool, entirely from the agent side, with the real call shapes.
---

This is the loop an agent runs the first time it needs a service it has never used:
see what exists, connect it, wait, find the tool, call it. Every call below is a
`tools/call` against one of the nine meta-tools, with the exact argument shapes the
schemas declare.

GitHub is the example because it is `oauth2` — the mode the agent can drive on its
own. API-key and cookie integrations need a human in the portal. That difference is
covered at the end.

:::steps

### See what is available

```json
{ "name": "list_integrations", "arguments": {} }
```

```json
{
  "integrations": [
    { "name": "github", "version": "1.0.0", "connected": false },
    { "name": "atlassian-jira", "version": "1.0.0", "connected": true },
    { "name": "browser", "version": "1.0.0", "connected": true }
  ]
}
```

`connected` is per user and computed live: always `true` for built-ins,
cookie-bundle validity for cookie integrations, and "a stored token exists" for
everything else. The response carries name, version, and status only — display
names, logos, and tool counts are portal-API territory.

### Start the connection

```json
{ "name": "connect", "arguments": { "integration": "github" } }
```

```json
{
  "connectionId": "3f0c1a2e-…",
  "type": "oauth2",
  "url": "https://workbench.example.com/connect/github?t=eyJhbGciOi…"
}
```

Give the user that URL. Do not try to fetch it — it is a workbench link for a
human browser, not the provider's consent page. It names this agent's workbench
user, and opening it requires being signed in to workbench as that same user; a
different signed-in user gets a mismatch page instead of a credential prompt. Only
after that check passes does the server build the actual provider consent URL and
send the human there.

A few responses to expect instead:

| Response | Meaning |
|---|---|
| `{"error":"Integration not found"}` | Wrong name. Check `list_integrations`. |
| `{"error":"<name> is built-in and always connected — no connect needed."}` | `browser` and `jots`. |
| `{"error":"…not configured"}` | The operator has not set `<PLUGIN>_CLIENT_ID` / `_SECRET`. |

For a cookie integration, `connect` returns `type: "cookie"` and the same shape of
workbench link — the user opens it, and after the account check, signs in to the
target service live and clicks Capture.

`get_auth_url` is a deprecated alias with an identical handler. Use `connect`.

### Wait for it

```json
{
  "name": "wait_for_connection",
  "arguments": { "connectionId": "3f0c1a2e-…", "timeoutSec": 300 }
}
```

```json
{ "status": "CONNECTED" }
```

`timeoutSec` is optional — a positive integer, default 300, maximum 900. The server
polls once a second and returns `CONNECTED`, `TIMEOUT`, or `EXPIRED`. An id the
server does not know — including a valid one belonging to another user, which
returns the same thing so it cannot be probed — comes back as
`{ error: "Unknown connectionId" }`.

> [!WARNING] `TIMEOUT` ends that connection attempt for good
> On timeout the handler reaps the pending record, setting it to `EXPIRED`. Calling
> `wait_for_connection` again with the same `connectionId` returns `EXPIRED` at once,
> and because the callback only promotes records still in `PENDING`, that record can
> never become `CONNECTED` — even if the user finishes consent a second later. Start
> over with `connect()` and give the user the fresh URL.

### Find the tool

```json
{ "name": "search_tools", "arguments": { "query": "github repos" } }
```

```json
{
  "tools": [
    {
      "name": "github_list_repos",
      "description": "List the authenticated user's GitHub repositories as slim rows …",
      "integration": "github"
    }
  ]
}
```

Descriptions carry the working detail — what the tool returns, what to call next,
what the defaults are. Read them before reaching for the schema.

### Check the schema when the arguments are not obvious

```json
{ "name": "get_tool_schema", "arguments": { "tool": "github_create_issue" } }
```

```json
{
  "schema": {
    "type": "object",
    "properties": {
      "owner": { "type": "string" },
      "repo": { "type": "string" },
      "title": { "type": "string" },
      "body": { "type": "string" },
      "labels": { "type": "array", "items": { "type": "string" } }
    },
    "required": ["owner", "repo", "title"]
  }
}
```

The plugin's Zod schema is converted to JSON Schema for you. An unknown tool name
returns `{"error":"Tool not found"}`.

### Execute

```json
{
  "name": "execute_tools",
  "arguments": {
    "executions": [
      { "tool": "github_list_repos", "args": { "perPage": 10 } }
    ]
  }
}
```

```json
{ "results": [ { "result": [ { "full_name": "acme/demo-repo", "private": false } ] } ] }
```

`args` is optional and defaults to `{}`. A single tool is a one-element array —
**there is no singular `execute_tool`.**

:::

## Batching

`executions` takes as many entries as you need. They run concurrently through a
bounded pool of 8, and `results` is index-aligned with what you sent, so entry *n*
of the response is the outcome of entry *n* of the request.

```json
{
  "name": "execute_tools",
  "arguments": {
    "executions": [
      { "tool": "github_list_repos", "args": { "perPage": 5 } },
      { "tool": "github_create_issue",
        "args": { "owner": "acme", "repo": "demo-repo", "title": "Flaky test",
                  "labels": ["bug"] } },
      { "tool": "slack_send_message", "args": { "channel": "C123", "text": "opened" } }
    ]
  }
}
```

One failure does not abort the others. Each entry is either `{result}` or
`{error, …}`:

```json
{
  "results": [
    { "result": [ … ] },
    { "error": "Invalid arguments for github_create_issue: …" },
    { "error": "NOT_CONNECTED", "integration": "slack",
      "message": "slack not connected. Use connect('slack') to connect." }
  ]
}
```

`NOT_CONNECTED` is the only error shape with extra fields, and it tells you exactly
which `connect()` call to make. Everything above is still a *successful* JSON-RPC
response — read `results[i].error`, not the JSON-RPC `error` field.

## Modes the agent cannot drive

| Auth mode | How it connects |
|---|---|
| `oauth2` | `connect()` from the agent, or the portal. |
| `cookie` | `connect()` returns a portal login URL; the user signs in live and captures. |
| `apikey` | Portal only. The manifest declares the fields; the portal renders and submits them. |
| `none` | Always connected. `browser` and `jots`. |

`connect` has no API-key branch — calling it on an API-key integration falls into
the OAuth path and errors. Point the user at the portal instead.

## Where to go from here

:::cards 2
- [Discovering tools](../guides/discovering-tools.md) — Searching, schemas, and the result cap.
- [Executing tools](../guides/executing-tools.md) — Batching, errors, and retries.
- [Raw API calls](../guides/curl-session.md) — When no tool wraps the endpoint you need.
- [All integrations](../integrations/index.md) — Every service, scope, and tool.
:::
