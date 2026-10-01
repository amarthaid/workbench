---
title: REST endpoint
description: POST /rest/:integration — plain JSON tool execution with no JSON-RPC framing and no 60,000-character result cap, on the same credentials and the same execution engine as /mcp.
---

`POST /rest/:integration` runs any plugin tool over plain JSON. It is the same
execution path as [`/mcp`](mcp-endpoint.md) — the same credentials, the same
connection check, the same Zod validation and defaults, the same audit rows and
Prometheus counters — with the MCP envelope removed.

Two things make it worth reaching for:

- **No result cap.** The 60,000-character truncation belongs to the MCP renderer, not
  to execution. A REST response carries the tool's whole payload.
- **No JSON-RPC.** No `initialize` handshake, no `tools/call` wrapper, no content
  blocks. Anything that can POST JSON is a client: `curl`, a cron job, a Lambda, a
  language without an MCP SDK.

Agents should still prefer `/mcp`. This endpoint exists for everything that is not an
agent.

## The call

Everything the call needs is in the body. The path names the integration; the body
names the tool.

```bash
curl -X POST http://localhost:3000/rest/github \
  -H "x-workbench-api-key: $WORKBENCH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"tool":"github_list_prs","args":{"owner":"acme","repo":"demo-repo"}}'
```

```json
{
  "integration": "github",
  "tool": "github_list_prs",
  "result": { "…": "the whole github payload, uncapped" }
}
```

### Three body shapes

| Shape | Body | When |
|---|---|---|
| Wrapped | `{ "tool": "github_list_prs", "args": { "owner": "acme" } }` | Always correct; the one to script against |
| Flat | `{ "tool": "github_list_prs", "owner": "acme" }` | Convenience — every key except `tool`, `args` and `executions` is treated as a tool argument |
| Batch | `{ "executions": [ { "tool": …, "args": … }, … ] }` | Several tools in one round trip |

`args` wins when both are present: if a body carries `args`, the sibling keys are
ignored. A tool that genuinely has an argument named `tool`, `args` or `executions`
must use the wrapped shape. The flat shape is a single-call convenience only — inside
a batch, each execution needs its own `args`.

### Tool names

Both spellings resolve:

```json
{ "tool": "github_list_prs" }   // fully-qualified registry name
{ "tool": "list_prs" }          // bare suffix — the path already said github
```

The integration in the path is authoritative. A tool that exists but belongs to
another integration is refused with 404 rather than executed, so `POST /rest/github`
can never reach a Jira tool. Built-in tools that carry no integration prefix
(`list_jots`) resolve under their own integration by their literal name.

The response always echoes the resolved, fully-qualified `tool`.

## Authenticating

The same three credentials as `/mcp`, resolved in the same order: the
`x-workbench-api-key` header, an OAuth 2.1 access token as `Authorization: Bearer`,
then a portal session JWT as the same header. An API key is the natural fit for a
script.

An unauthenticated request gets 401 with the same `WWW-Authenticate` challenge
`/mcp` sends, so an OAuth-capable client can discover the flow from here too — but
the body is plain JSON, not a JSON-RPC error:

```json
{ "error": "Unauthorized", "resource_metadata": "<SERVER_PUBLIC_URL>/.well-known/oauth-protected-resource" }
```

## Status codes

A single execution maps its outcome onto HTTP. This is the only thing the REST layer
decides on its own — the error strings themselves come from the shared engine.

| Status | Meaning | Body |
|---|---|---|
| 200 | The tool ran | `{ integration, tool, result }` |
| 400 | Body is not a JSON object, carries no `tool`, or the plugin's schema rejected the args | `{ error }`, with `Invalid arguments for <tool>: …` for a schema failure |
| 401 | No credential, or an unverifiable one | `{ error: "Unauthorized", resource_metadata }` |
| 404 | Unknown integration, unknown tool, or a tool belonging to a different integration | `{ error, integration }` |
| 409 | The integration is not connected for this user | `{ error: "NOT_CONNECTED", integration, tool, message }` |
| 415 | Content type is not JSON | Fastify error shape |
| 502 | The plugin handler or its upstream failed | `{ error, integration, tool }` — `error` is the upstream message |

A 409 means connect first. Connecting is not part of this endpoint: use the portal,
or the `connect` meta-tool on `/mcp`.

## Batch

The batch shape has the same semantics as the [`execute_tools`](meta-tools.md)
meta-tool: HTTP **200** whatever happens, a `results` array **index-aligned with
`executions`**, and one failing item never aborting the others. Executions run
through the same bounded worker pool, concurrency **8**.

```bash
curl -X POST http://localhost:3000/rest/github \
  -H "x-workbench-api-key: $WORKBENCH_API_KEY" \
  -H "content-type: application/json" \
  -d '{"executions":[
        {"tool":"list_prs","args":{"owner":"acme","repo":"demo-repo"}},
        {"tool":"list_issues","args":{"owner":"acme","repo":"demo-repo"}}
      ]}'
```

```json
{
  "integration": "github",
  "results": [
    { "result": { "…": "prs" } },
    { "error": "NOT_CONNECTED", "integration": "github", "message": "…" }
  ]
}
```

Every execution in one batch belongs to the integration in the path. To span
integrations, use `execute_tools` on `/mcp`, or send one request per integration.

## Discovery

Two GET routes exist so a REST client never has to open an MCP session to learn what
it can call. Both need the same credential.

`GET /rest` — integrations, with this user's connection status:

```json
{
  "integrations": [
    { "name": "github", "displayName": "GitHub", "authType": "oauth2",
      "connected": true, "toolCount": 24, "url": "/rest/github" }
  ]
}
```

`GET /rest/:integration` — that integration's tools, each with a portable JSON
Schema (no Zod internals):

```json
{
  "integration": "github",
  "connected": true,
  "tools": [
    { "name": "github_list_prs", "description": "…", "inputSchema": { "type": "object", "…": "…" } }
  ]
}
```

Meta-tools are not reachable here. `search_tools`, `connect`, `wait_for_connection`
and `curl_session` live on `/mcp`; `GET /rest` and `GET /rest/:integration` cover the
discovery half of that surface for REST callers.

## Body parsing

Requests are parsed as JSON only, within this endpoint's own Fastify scope:

- An **empty body with a JSON content-type** parses to `{}` rather than failing with
  `FST_ERR_CTP_EMPTY_JSON_BODY`
  ([finding](../field-notes/2026-06-10-empty-json-body-bodyless-post.md)). It then
  fails on the missing `tool`, which is the useful error.
- A **non-JSON content type** is refused with 415 instead of reaching a tool.
  Form-encoded arguments would arrive as all-strings and die in the plugin's own Zod
  schema with a far more confusing message.

Both rules are scoped to `/rest`; the rest of the server keeps Fastify's strict
defaults.

## Differences from /mcp, in full

| | `POST /mcp` | `POST /rest/:integration` |
|---|---|---|
| Framing | JSON-RPC 2.0 | Plain JSON |
| Result cap | 60,000 chars, then truncated | None |
| Errors | JSON-RPC error object, or `{error}` inside a result | HTTP status + `{ error }` |
| Images | `_mcpImage` becomes an MCP image block | Passed through as JSON, base64 in `result` |
| Tool surface | 9 meta-tools; plugin tools via `execute_tools` | Plugin tools directly |
| Connecting | `connect` / `wait_for_connection` | Not available — portal or `/mcp` |
| Audit + metrics | Yes | Yes, identical rows and counters |

Because the audit rows are identical, a REST call shows up in the portal's Activity
view exactly like an agent call. There is no way to tell them apart after the fact,
which is deliberate: the credential and the user are what matter, not the envelope.

> [!WARNING] Uncapped means uncapped
> A tool that returns 40 MB will send 40 MB. That is the point of the endpoint, but
> point an agent at it and you can still blow its context window. If the caller is a
> model, use `/mcp`.
