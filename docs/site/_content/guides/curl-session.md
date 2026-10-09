---
title: Raw API calls with curl_session
description: Mint a short-lived proxy token that forwards arbitrary HTTP requests to a provider's API with your credential injected.
---

The tool catalog is wide but not complete. GitHub alone has hundreds of endpoints, and the
plugin wraps 28 of them. When the endpoint you need has no tool, `curl_session` is the
escape hatch. It mints a short-lived token (15 minutes unless you ask otherwise) that lets you send **any** HTTP request to that
provider's API through the workbench, with your real credential attached server-side.

You never see the credential. The proxy injects it.

> [!WARNING] This tool is deliberately marked HIGH RISK in its own description
> `curl_session` grants arbitrary GET/POST/PUT/PATCH/DELETE against the named
> integrations, including destructive writes. Anything reachable with the user's
> credential is reachable through the minted token. The tool description instructs the
> calling agent to name the integrations and the intended action, and to wait for
> explicit user approval, before invoking it. It also instructs the agent not to mint
> speculatively or as a default first step. An MCP client that surfaces tool
> descriptions shows this to the user. One that does not, does not. As the operator, treat a minted curl session as
> a consent event worth auditing.

## When to reach for it

| Situation | Use |
|---|---|
| A tool exists for the operation | [`execute_tools`](executing-tools.md) — validated args, slim responses, audit trail per tool |
| No tool wraps the endpoint | `curl_session` |
| You want a permanent capability | Write a plugin tool instead |

Prefer a tool where one exists. Tool calls get argument validation, per-tool audit
entries, and per-tool metrics. A proxied request gets an HTTP request log and nothing
tool-shaped.

## Minting a session

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name": "curl_session",
  "arguments": { "integrations": ["github"] }
}}
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9…",
  "expiresIn": 900,
  "proxyBaseUrl": "https://workbench.example.com/c",
  "usage": "Send requests to https://workbench.example.com/c/<integration>/<path> with Authorization: Bearer <token>"
}
```

`integrations` is required and must have at least one entry. Multiple integrations in
one session are allowed, and the token then covers all of them.

`expiresInSeconds` is optional: an integer from `60` to `3600` (1 hour), default `900`.
Anything outside that range, or a fraction, is rejected before a token is minted. The
response's `expiresIn` is the lifetime you got. Ask for the shortest lifetime the job needs.

```json
{ "name": "curl_session", "arguments": { "integrations": ["github"], "expiresInSeconds": 300 } }
```

Validation is **all-or-nothing**. Every requested name is checked, the failures are
collected, and if there is even one the call returns an error and mints nothing:

```json
{ "error": "gitlab: not connected; httpbin-cookie: curl proxy not enabled" }
```

The three per-name reasons are `integration not found`, `curl proxy not enabled`, and
`not connected`.

### The token

- A JWT with audience `workbench-curl`, carrying the user id and the list of allowed
  integrations.
- TTL is set at mint: `expiresInSeconds`, default **900 seconds**, capped at **3600**. There
  is no refresh or revoke — you mint a new one.
- It is *only* accepted at `/c/:integration/*`. It does not authenticate `/mcp` or
  `/api/*`.

## The URL shape

```
<SERVER_PUBLIC_URL>/c/<integration>/<path><?query>
```

The path tail after the integration name is appended to the resolved base URL, and the
original query string is preserved verbatim.

```bash
TOKEN='eyJhbGciOiJIUzI1NiJ9…'

# GET https://api.github.com/repos/acme/demo-repo/labels?per_page=100
curl -s "https://workbench.example.com/c/github/repos/acme/demo-repo/labels?per_page=100" \
  -H "Authorization: Bearer $TOKEN"

# POST with a JSON body — bytes are forwarded exactly as sent
curl -s -X POST "https://workbench.example.com/c/github/repos/acme/demo-repo/labels" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"needs-triage","color":"ededed"}'
```

`GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` and `OPTIONS` are routed. The response
comes back with the upstream status and headers, and the body is **streamed** — nothing
is buffered, so large downloads work.

## How the credential is injected

Your `Authorization` header never reaches the provider. The proxy strips it — along with
the usual hop-by-hop headers (`host`, `connection`, `transfer-encoding`, `te`, `trailer`,
`keep-alive`, `proxy-authorization`, `upgrade`, and `content-length`, which is
recomputed) — and then sends the request through the same `ctx.http()` that plugin tools
use. That is where the real credential goes on, according to the integration's declared
auth type:

| Auth type | What is attached |
|---|---|
| `oauth2` | `Authorization: Bearer <access token>`, refreshed first if it expires within 30s |
| `apikey` | The manifest's `headerName` set to the stored key **verbatim** — no `Bearer` prefix — after the `allowedHosts` check |
| `cookie` | A `Cookie` header built from the unexpired cookies scoped to the target host, with redirects disabled |

Every other header you send is forwarded as-is, so `Accept`, `Content-Type`, and
provider-specific headers all work.

Because the credential is attached by the same layer plugin tools use, an expired OAuth
token is refreshed and re-stored transparently on a proxied call, exactly as it would be
on a tool call.

## How the target base is resolved

An integration is proxy-capable only if its manifest declares a `proxy` block. Fifteen
of the eighteen shipped plugins do. `httpbin-cookie`, `clevertap`, and `storybooks` do not.

### Static `baseUrl`

Most integrations pin one base:

```ts
proxy: { baseUrl: "https://api.github.com" }
```

A trailing slash is stripped, then `/<path>` is appended.

### `resolver: "instance-url"`

For integrations that can point at a self-hosted deployment. The base comes from the
per-connection `instanceUrl` stored at connect time, plus the manifest's `pathPrefix`.
GitLab:

```ts
proxy: { resolver: "instance-url", pathPrefix: "/api/v4" }
```

A connection to `https://gitlab.example.com` makes
`/c/gitlab/projects` resolve to `https://gitlab.example.com/api/v4/projects`. If the
connection has no `instanceUrl`, the request fails with 502 and
`No instanceUrl in connection config for gitlab`. See
[Self-hosted instances](self-hosted-instances.md).

### `resolver: "newrelic-region"`

Region-scoped NerdGraph. The per-connection `region` config decides:

| `region` | Base |
|---|---|
| `EU` | `https://api.eu.newrelic.com/graphql` |
| anything else (including unset) | `https://api.newrelic.com/graphql` |

### The Atlassian `cloud-id` placeholder

Jira and Confluence declare bases containing the literal segment `cloud-id`:

```
https://api.atlassian.com/ex/jira/cloud-id
https://api.atlassian.com/ex/confluence/cloud-id/wiki
```

That is not a variable you substitute. `ctx.http()` recognises the pattern and swaps in
the real cloud id for your connection, resolved once from Atlassian's
`accessible-resources` endpoint and cached per user and product for the process
lifetime. Send `/c/atlassian-jira/rest/api/3/myself` and the placeholder is handled for
you.

## Failure modes

Returned by the proxy itself, in the order they are checked:

Every one of these is a JSON object with a single `error` key — e.g.
`{"error":"Invalid or expired curl session token"}`. The table gives the `error` string.

| Status | `error` | Meaning |
|---|---|---|
| 401 | `Authorization: Bearer <curl-session-token> required` | No bearer header |
| 401 | `Invalid or expired curl session token` | Bad signature, wrong audience, or past its `expiresIn` |
| 403 | `Integration "x" is not in this curl session` | Valid token, but that integration was not in `integrations` at mint |
| 400 | `Integration "x" does not support curl proxy` | The manifest has no `proxy` block |
| 502 | `Cannot resolve proxy base URL: <reason>` | A dynamic resolver had nothing to work with |
| 502 | `Upstream request failed: <reason>` | The outbound request threw — DNS, TLS, a host the credential layer refused |

Anything else you see is the upstream provider's own response, passed through unchanged.

## Operator notes

The proxy sits behind the same server as `/mcp` and the portal, and it inherits the same
credential store. Two things follow:

- A minted token is a bearer credential for the user's full API access to the named
  integrations, until it expires (15 minutes by default, 1 hour at most), with no revocation path. It is worth treating leaked
  curl tokens the way you would treat a leaked provider token — the mitigation is the
  short TTL.
- Proxied requests appear in the HTTP request metrics
  (`workbench_http_requests_total`, labelled by route) and in the Fastify request log,
  but produce **no `audit_log` entries** — the audit trail records tool executions, and
  no tool ran. The mint is not audited either: meta-tool calls do not write audit rows.
  If you need per-request provenance for an integration, a plugin tool is the right
  shape, not the proxy.
