---
title: Other MCP clients
description: The endpoint, the transport, the three credentials, and the OAuth 2.1 discovery a client can follow on its own.
---

Any MCP client that can POST JSON-RPC over HTTP can use a workbench. There is one
endpoint and no session state to manage.

## The endpoint

```
POST <SERVER_PUBLIC_URL>/mcp
Content-Type: application/json
```

That is the entire MCP surface. Specifically:

- **No `GET /mcp`**, no SSE stream, no `DELETE /mcp`.
- **No session handling.** `Mcp-Session-Id` is never read or emitted. Every
  request is authenticated independently and statelessly.
- Exactly two methods produce **202 Accepted with an empty body**:
  `notifications/initialized` and `initialized`. Every other method returns a full
  JSON-RPC body even when you send it without an `id`.

Supported JSON-RPC methods:

| Method | Response |
|---|---|
| `initialize` | Echoes your `protocolVersion` (default `2025-06-18`), `capabilities: {tools:{}}`, `serverInfo` |
| `notifications/initialized` | 202, no body |
| `tools/list` | The nine meta-tools with their JSON Schemas |
| `tools/call` | The meta-tool result as one text content block |
| `resources/list` | `{resources: []}` |
| `prompts/list` | `{prompts: []}` |

Anything else is `-32601 Method not found`.

## The three credentials

`/mcp` accepts three, resolved in a strict order.

| Credential | Header | Notes |
|---|---|---|
| Workbench API key | `x-workbench-api-key: <hex>` | Checked first. 32 random bytes, minted in the portal. Never send it as `Bearer`. |
| OAuth 2.1 access token | `Authorization: Bearer <jwt>` | Tried before the session JWT. Audience `<SERVER_PUBLIC_URL>/mcp`. Default TTL 1 hour. |
| Portal session JWT | `Authorization: Bearer <jwt>` | Fallback if the token is not a valid OAuth access token. 24-hour lifetime. |

One `Authorization: Bearer` header therefore covers both the OAuth flow and a
portal session. The API key needs its own header.

> [!NOTE] `/api/*` is stricter than `/mcp`
> The portal API accepts the API key or a portal session JWT. It does **not**
> accept an OAuth access token — that credential authenticates `/mcp` only.

## The 401 challenge

An unauthenticated call returns HTTP 401 with:

```
WWW-Authenticate: Bearer realm="workbench",
  resource_metadata="<SERVER_PUBLIC_URL>/.well-known/oauth-protected-resource"
```

and a JSON-RPC error body echoing your request `id`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Unauthorized",
    "data": { "resource_metadata": "https://…/.well-known/oauth-protected-resource" }
  }
}
```

A conforming client can bootstrap from that header alone.

## OAuth 2.1 discovery

Both metadata documents are unauthenticated GETs.

| Endpoint | Returns |
|---|---|
| `/.well-known/oauth-protected-resource` | `resource`, `authorization_servers`, `bearer_methods_supported: ["header"]`, `scopes_supported: ["mcp"]` |
| `/.well-known/oauth-authorization-server` | `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`, and the supported grants below |

Advertised capabilities:

| Field | Value |
|---|---|
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` |
| `scopes_supported` | `["mcp"]` |

## Dynamic client registration

```bash
curl -s -X POST https://your-workbench.example.com/register \
  -H 'content-type: application/json' \
  -d '{"client_name":"my-agent","redirect_uris":["http://127.0.0.1:7777/callback"]}'
```

Returns **201** with `client_id`, the echoed `client_name` and `redirect_uris`,
`token_endpoint_auth_method: "none"`, `grant_types`, and `response_types`. A
missing or empty `redirect_uris` is a 400 `invalid_client_metadata`.

**No client secret is ever issued.** Every registered client is public, which is
why PKCE is mandatory rather than optional.

## The authorization code flow

```
GET /authorize
  ?client_id=…
  &response_type=code
  &redirect_uri=…            exact match against a registered URI
  &code_challenge=…
  &code_challenge_method=S256
  &scope=mcp                 optional, defaults to "mcp"
  &state=…                   optional, echoed back
  &resource=…                optional, defaults to <SERVER_PUBLIC_URL>/mcp
```

The server validates the client, the response type, the redirect URI as an exact
member of the registered list, and PKCE — `S256` only, `plain` is rejected. Then it
redirects the user to **Google**. After sign-in the browser lands back on your
registered `redirect_uri` with `?code=` (and `&state=` if you sent one).

> [!WARNING] The agent OAuth flow requires Google
> `/authorize` builds its redirect with the Google authorization URL builder, which
> throws if `GOOGLE_CLIENT_ID` is unset, and only the Google callback carries the
> ticket-resumption branch that returns the user to `/authorize`. Keycloak can log a
> user into the portal, but it cannot complete this flow. On a Keycloak-only
> deployment, use a workbench API key as the agent credential instead.

Authorization codes live **60 seconds** and are single-use: a lookup consumes the
code whether or not the exchange then succeeds.

Exchange it:

```bash
curl -s -X POST https://your-workbench.example.com/token \
  -d grant_type=authorization_code \
  -d code=… -d client_id=… -d redirect_uri=… -d code_verifier=…
```

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "…",
  "scope": "mcp"
}
```

Refresh the same way with `grant_type=refresh_token`, `refresh_token`, and
`client_id`. **Refresh tokens rotate on every redemption** — you always get a new
one back, and the presented one is burned. They live 30 days. An unrecognized
grant type is a 400 `unsupported_grant_type`. A bad code or refresh token is a 400
`invalid_grant`.

> [!WARNING] `/register` is open
> Dynamic client registration requires no initial access token and is not rate
> limited. If your workbench is internet-facing, put it behind whatever ingress
> controls you would use for any unauthenticated POST endpoint.

## Reading results

A meta-tool result comes back as a single `{"type":"text"}` content block holding
the JSON-stringified return value, capped at **60,000 characters**. Past the cap it
is truncated and a notice is appended — and the truncated text is deliberately not
valid JSON, so a client cannot mistake a partial response for a whole one.

One exception: if the result carries image data, the content becomes image blocks
instead and the text block is dropped. `browser_screenshot` is the tool that does
this.

Plugin-tool failures are not JSON-RPC errors. Only an unknown meta-tool name or
invalid meta-tool arguments produce a JSON-RPC `error` (code `-32602`). Everything
else — a tool that does not exist, is not connected, or threw — arrives as a
successful result containing `{"results":[{"error": …}]}`. Check inside.
