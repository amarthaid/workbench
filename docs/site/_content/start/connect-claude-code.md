---
title: Claude Code
description: Wire Claude Code to a workbench with either an API key or OAuth, and fix it when it doesn't appear.
---

Claude Code reaches a workbench over HTTP as a remote MCP server. Configuration is
one entry in `.mcp.json`. The only real decision is which credential it carries.

## Pick an auth path

| Use | Auth | Config needs |
|---|---|---|
| Interactive — you, at a terminal | OAuth browser login | server `url` only |
| Headless, CI, scripts | Workbench API key | `url` plus a `headers` block |

These are two different tokens and they travel in two different headers.
`Authorization: Bearer` carries an OAuth access token or a portal session JWT. The
API key travels in `x-workbench-api-key`, which the server checks first and
separately.

> [!WARNING] An API key in a `Bearer` header will not authenticate
> The server tries a `Bearer` value as an OAuth access token, then as a session
> JWT. An API key is neither, so it fails both and you get a 401 that looks like
> an OAuth problem.

## Write the config

Put `.mcp.json` at the project root.

:::tabs
```json [OAuth]
{
  "mcpServers": {
    "workbench": {
      "url": "https://your-workbench.example.com/mcp"
    }
  }
}
```
```json [API key]
{
  "mcpServers": {
    "workbench": {
      "url": "https://your-workbench.example.com/mcp",
      "headers": { "x-workbench-api-key": "YOUR_API_KEY" }
    }
  }
}
```
:::

Note there is no trailing comma after the `headers` object. A single stray comma
makes the file invalid JSON, and Claude Code then drops the whole server — it will
not appear in `claude mcp list` at all, and the only clue is:

```
[Failed to parse] Project config (shared via .mcp.json)
  └ [Error] MCP config is not a valid JSON
```

Validate before going further:

```bash
python3 -m json.tool .mcp.json
```

## Load and confirm

Claude Code does not re-read `.mcp.json` mid-session. After any edit, restart the
session, then check the server is parsed and reachable:

```bash
claude mcp list
# workbench: https://your-workbench.example.com/mcp (HTTP) - ✓ Connected
```

If `workbench` is missing from that list, stop — it is a config problem, not an
auth problem. Go back and validate the JSON.

## Authorize (OAuth path only)

On first use the client discovers the authorization server from the 401 challenge,
registers itself through Dynamic Client Registration, and opens a browser to sign
in with **Google** — the workbench's `/authorize` redirects there specifically, and
fails if `GOOGLE_CLIENT_ID` is unset. Keycloak covers portal login only. It cannot
complete this flow, so a Keycloak-only deployment must use the API-key path above.
After you sign in, the client holds an access token and a refresh token and renews
them on its own — you do not repeat this.

If the browser lands on a page that cannot reach your machine — common over SSH,
where the client's `localhost:<port>/callback` is not reachable from where the
browser runs — copy the **full** callback URL out of the address bar, including
`?code=…`, and hand it back to the client's completion tool.

A workbench also serves `GET /oauth/callback` as an out-of-band landing page for
clients registered against it. It does no server-side work at all: no code
exchange, no token storage. It renders the current URL into a text field for you
to copy back to a CLI agent, and nothing else.

## Verify end to end

Ask for something that requires the server:

```
You: list my integrations
Claude: list_integrations()  → integrations with per-user connection status
```

`whoami` is the smaller check — it returns the workbench user id and email and
touches no integration.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `MCP config is not a valid JSON`; server absent from `claude mcp list` | trailing comma or syntax error in `.mcp.json` | validate with `python3 -m json.tool`, remove the offending comma |
| Server loads but its tools are missing | config edited but not reloaded | restart the session |
| `401` with `WWW-Authenticate: Bearer …` on `/mcp` | no or invalid credential | OAuth: complete the browser login. API key: confirm the header is present |
| Authorized but every call still 401s | API key sent in `Authorization: Bearer` | move it to `x-workbench-api-key` |
| Tool calls return `{"error":"NOT_CONNECTED"}` | the workbench user has no credential for that integration | `connect('<integration>')`, then `wait_for_connection` |
| A tool "succeeds" but the content is an error object | plugin-tool failures are not JSON-RPC errors | read `results[i].error` in the response body |
| Connected to the wrong workbench | two similarly named servers, e.g. staging and production | check the exact `url` in `claude mcp list` — each server is authorized separately |
| Results end mid-JSON with a truncation notice | the 60,000-character result cap | narrow the request with the tool's `limit`, `fields`, or pagination arguments |

## What Claude Code sees

Only the nine meta-tools, prefixed by the server name — `mcp__workbench__search_tools`,
`mcp__workbench__execute_tools`, and so on. Plugin tools are never advertised
individually. An agent reaches them by name through `execute_tools`. That is the point
of the design, and it is why adding integrations does not grow the tool list.

Next: [Your first integration](first-connection.md).
