---
title: Plugin context API
description: The ToolContext object every handler receives — userId, getToken, http, getConfig — what each does per auth type, and the host guards your plugin is responsible for.
---

Every tool handler is called as `handler(ctx, args)`. `ctx` is a `ToolContext`,
built fresh for the `(userId, integration)` pair before each execution.

```ts
export interface ToolContext {
  userId: string;
  getToken(): Promise<string>;
  http(url: string, init?: RequestInit): Promise<Response>;
  // Per-connection config set at connect time (e.g. { instanceUrl } for a
  // self-hosted GitLab). Returns {} when none was stored.
  getConfig(): Record<string, unknown>;
}
```

That is the entire surface. There is no database handle, no filesystem, no
logger, and no browser — the internal `browser` and `jots` plugins reach those
from server source precisely so that plugins cannot.

| Member | Sync? | Returns |
|---|---|---|
| `userId` | — | The workbench user id as a string. |
| `getToken()` | Async | The decrypted access token, refreshing it first if needed. |
| `http(url, init?)` | Async | A `fetch` `Response`, with the user's credential attached. |
| `getConfig()` | Sync | The per-connection config object, or `{}`. |

## `ctx.userId`

The id of the workbench user the tool is running for. Use it to key any per-user
state your plugin keeps outside the workbench. Never use it as a credential — it
is an identifier, not a secret.

## `ctx.getConfig()`

Synchronous, because the connection config is fetched and parsed while the
context is being built. Returns the JSON object stored on the connection at
connect time, or `{}` when nothing was stored or the stored JSON fails to parse
(the parse failure is swallowed).

Two things populate it:

| Auth type | Contents |
|---|---|
| `oauth2` with an `instance` block | `{ instanceUrl }` — the origin the user chose. |
| `apikey` | Every non-secret field from the manifest's `fields[]`, keyed by `field.key`. |

The GitLab plugin reads it on every call, defaulting to the cloud origin:

```ts
function origin(ctx: any): string {
  const u = ctx.getConfig?.()?.instanceUrl;
  return typeof u === "string" && u ? u.replace(/\/+$/, "") : DEFAULT_ORIGIN;
}
```

New Relic reads `region` and `accountId` the same way — the secret field
(`apiKey`) is *not* in `getConfig()`. The server stores it encrypted as the token and
attached by `ctx.http()`.

## `ctx.getToken()`

Returns the decrypted access token. The token is loaded lazily on first call and
memoised for the life of the context, so calling it repeatedly in one handler is
free.

- Throws `"Not connected"` if no token is stored.
- Refreshes when `expiresAt - 30s <= now`. The 30-second skew means a token about
  to expire mid-flight is refreshed rather than used.
- Refresh is a form-encoded `grant_type=refresh_token` POST to the resolved token
  URL (the instance-swapped one, for self-hosted integrations). The rotated token
  is persisted, and the previous `refresh_token` is kept if the provider does not
  return a new one.
- Refresh throws if there is no stored `refresh_token`, if the integration is not
  `oauth2`, or if no OAuth client is configured for it. A missing refresh token,
  or a token endpoint answering 400/401 (`invalid_grant`), throws
  `TokenRefreshError`, which the tool call reports as `NOT_CONNECTED` so the
  agent or Space viewer knows to reconnect. Other refresh failures (5xx,
  timeout) stay plain errors.
- Only one refresh runs at a time per user and integration, across every
  process: concurrent callers wait and reuse the new token. A caller that finds
  the stored token already replaced uses it without refreshing. This matters for
  providers that rotate refresh tokens, which reject a second refresh with the
  same one.

Most handlers never call `getToken()` — `ctx.http()` does it for them. For an
`oauth2` integration with a stored refresh token, `ctx.http()` also retries once
when the upstream answers **401**: it refreshes (sharing the refresh above) and
re-sends the same request with the new token. A second 401 is returned as is.
It does not retry a 403 (a permission problem), or a request whose body is a
stream. A 401 from Atlassian's `accessible-resources` lookup counts the same way. Call it
directly only when you need the raw token in a payload, as
`github_get_clone_url` does when minting an `https://x-access-token:<token>@…`
URL.

## `ctx.http(url, init)`

A `fetch` wrapper that attaches the user's credential. **Always use it instead of
bare `fetch`** — a direct `fetch` skips authentication, the cookie-domain
allowlist, and the Atlassian cloud-id resolver.

Its behaviour branches on the integration's declared auth type.

| Auth type | Host check | Credential | Redirects |
|---|---|---|---|
| `apikey` | Only if `allowedHosts` is set | `headers[headerName] = token`, verbatim — no `Bearer` prefix | fetch default |
| `cookie` | Mandatory, against `targetDomain` + `cookieDomains` | A single `Cookie` header, filtered by expiry and domain | Forced `redirect: "manual"` |
| `oauth2` (and any other type) | **None** | `Authorization: Bearer <token>` | fetch default |

### `apikey`

Loads the token, then — **only if `allowedHosts` is non-empty** — checks the URL
host against it. Matching is case-insensitive, strips a leading dot, and accepts
an exact host or any subdomain of a listed host. A violation throws
``API-key auth: URL host <host> not in declared allowedHosts``.

The credential is then set as `headers[headerName] = token` with no
transformation. If the API expects `Authorization: Bearer <key>`, bake the
`Bearer ` prefix into the value the user pastes, or pick a different header.

### `cookie`

The host check here is **mandatory** and runs before anything is sent. The
allowed set is `targetDomain` plus every entry of `cookieDomains`, dot-stripped
and lowercased, matched as exact host or subdomain. A violation throws
``Cookie auth: URL host <host> not in declared cookieDomains``.

Cookies are then filtered twice — dropping anything expired, then anything whose
domain does not match the target host — joined into one `Cookie` header, and the
request is issued with `redirect: "manual"` so a redirect can never carry the
session cookie to another host. Your handler sees the 3xx itself.

### `oauth2`

Calls `ctx.getToken()` (refreshing if needed) and sets
`Authorization: Bearer <token>`. If the URL matches
`https://api.atlassian.com/ex/(jira|confluence)/cloud-id/`, the literal `cloud-id`
segment is replaced with the real site id, resolved once from
`/oauth/token/accessible-resources` and cached per `(userId, product)` in a
process-global map for the lifetime of the process.

## Security

> [!DANGER] The oauth2 branch of `ctx.http()` applies no host guard at all
> It sends `Authorization: Bearer <user's token>` to whatever URL you pass. If any
> part of that URL comes from tool arguments, an agent — or anyone who can
> influence the agent's input — can point it at a host they control and receive
> the user's access token. The same applies to `apikey` when `allowedHosts` is
> omitted. Guarding the host is the plugin's job.

Two shipped plugins accept a URL argument, and both guard it. Copy whichever
pattern fits.

### Allowlist the host, then drop the credential across redirects

`slack_download_file` takes a Slack file URL. It validates the scheme and host
*before* the credentialed request, then walks redirects by hand so the token
never follows one off Slack:

```ts
function isSlackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "slack.com" || h === "files.slack.com" || h.endsWith(".slack.com");
}
```

```ts
if (target.protocol !== "https:" || !isSlackHost(target.hostname)) {
  return { ok: false, error: "invalid_host" };
}

let url = target.toString();
let onSlack = true;
for (let hop = 0; hop < 5; hop++) {
  const hopRes = onSlack
    ? await ctx.http(url, { redirect: "manual" })
    : await fetch(url, { redirect: "manual" });
  // …
  onSlack = isSlackHost(next.hostname);
}
```

The loop caps the chain at five requests, the first of which is the original
fetch — so at most four redirects are followed.

Three things make this work: the host is checked before the first credentialed
call, `redirect: "manual"` keeps the hop loop in the plugin's hands, and the
moment the next hop leaves Slack the request switches to a plain `fetch` with no
`Authorization` header. It also rejects non-`https:` redirect targets, and treats
a `text/html` response as `not_authed_or_not_found` rather than handing back
Slack's login page as file bytes.

### Block private address ranges

`google_drive_upload_from_url` fetches an arbitrary user-supplied URL. It cannot
allowlist a host, so it blocks the SSRF-relevant ranges instead:

```ts
const parsed = new URL(args.url);
if (parsed.protocol !== "https:") {
  throw new Error("Only https:// URLs are allowed");
}
const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
const privateRange =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/;
const privateIPv6 = /^(::1$|fc|fd|fe80)/i;
if (host === "localhost" || privateRange.test(host) || privateIPv6.test(host)) {
  throw new Error("Requests to private or internal addresses are not allowed");
}
```

> [!WARNING] Known limitation of the private-range check
> This is a string test against the hostname, not against the address the name
> resolves to. A public DNS name that resolves to `127.0.0.1` or an RFC-1918
> address passes it. Prefer a host allowlist whenever the set of legitimate
> destinations is known.

### Practical rules

- If every destination is known in advance, hardcode the base URL in the handler
  and take only path components as arguments.
- If a URL must be an argument, validate scheme and host before the first call
  that carries a credential.
- For `apikey` plugins, set `allowedHosts` in the manifest. It is the only
  declarative guard available, and New Relic is the shipped precedent —
  `allowedHosts: ["api.newrelic.com", "api.eu.newrelic.com"]`.
- Never interpolate an argument into the host portion of a URL template.
