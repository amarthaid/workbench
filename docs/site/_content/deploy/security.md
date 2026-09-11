---
title: Security model
description: The credentials the server issues and accepts, how third-party tokens are protected at rest, the SSRF posture and its limits, and what the operator is responsible for.
---

workbench holds other people's credentials. A single deployment stores every
user's OAuth tokens and browser cookies for every SaaS tool they connected, and
hands agents a way to use them. This page is the operator's view of that.

To report a vulnerability, use the **Report a vulnerability** button under the
repository's Security tab. Do not open a public issue.

## The credentials in play

Seven distinct credential types exist. Four of them are HS256 JWTs signed with
`SESSION_SECRET` — portal session, MCP OAuth access token, connect token,
curl-session token — separated by audience and a distinguishing claim rather than
by key. The jot unlock cookie is keyed on the same secret but is **not** a JWT: it
is a bare HMAC-SHA256 hex digest over the jot's name and password hash, with no
header, no payload, and no expiry claim. The remaining two, the workbench API key
and the MCP OAuth refresh token, are random opaque strings.

| Credential | Authenticates | Where it comes from | Lifetime |
|---|---|---|---|
| Portal session JWT | The browser portal against `/api/*`, and `/mcp` as a fallback | Google or Keycloak SSO callback, delivered in the URL fragment | 24h |
| Workbench API key | A person or agent against `/api/*` and `/mcp`, via `x-workbench-api-key` | `POST /api/keys`, or the seed script | Until rotated |
| MCP OAuth access token | `/mcp` only | The MCP OAuth 2.1 flow: `/register` → `/authorize` → `/token` | `OAUTH_ACCESS_TOKEN_TTL_SECONDS`, default 1h |
| MCP OAuth refresh token | `/token` with `grant_type=refresh_token` | Same flow; rotated on every use | 30 days |
| Connect token | The magic-link connect page and the CDP live view | Minted by the `connect` meta-tool for a cookie integration | `CONNECT_TTL_SECONDS`, default 600s |
| Curl-session token | The `/c/<integration>/<path>` proxy, for the integrations named in the token | Minted by the `curl_session` meta-tool | 900s — a default parameter on the signer, and the only value any caller passes today |
| Jot unlock cookie | One password-protected jot | Submitting the jot's password | `Max-Age=2592000` (30 days); carries no expiry itself, and is invalidated by a password change |

Two boundaries matter operationally:

- **An OAuth access token authenticates `/mcp` and nothing else.** The `/api/*`
  routes accept only the `x-workbench-api-key` header or a portal session JWT. An
  agent holding an OAuth token cannot list connections, reveal an API key, or
  disconnect an integration.
- **The API key uses a dedicated header,** deliberately not `Authorization`, so it
  never collides with the two bearer-token types.

`/mcp` resolves a caller by trying the API-key header first, then the
`Authorization` bearer as an OAuth access token, then as a portal session JWT.
Unauthenticated requests get a 401 with a `WWW-Authenticate: Bearer` challenge
pointing at `${SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`.

The MCP OAuth server issues public clients only — dynamic client registration at
`POST /register` is unauthenticated and never issues a client secret, PKCE with
`S256` is mandatory on `/authorize`, `redirect_uri` must match a registered value
exactly, authorization codes live 60 seconds and are single-use, and refresh
tokens rotate on every use with single-use enforced inside a database transaction.

> [!WARNING] `POST /register` is open
> Dynamic client registration takes no initial access token and has no rate
> limiting in the application. Anyone who can reach the server can register a
> client id. That alone grants no access — the client still has to complete an SSO
> login to get a code — but if the deployment is internet-facing, rate-limit
> `/register` at the proxy.

Users can see and revoke the agents holding refresh tokens on their account:
`GET /api/agents` lists them by client, `DELETE /api/agents/:clientId` deletes
that client's refresh tokens and outstanding codes. Revocation is **soft** —
already-issued access tokens are self-contained JWTs and remain valid until they
expire, up to `OAUTH_ACCESS_TOKEN_TTL_SECONDS`.

## Credentials at rest

Third-party credentials are encrypted with **AES-256-GCM** before they reach the
database. The layout is a 16-byte IV, a 16-byte auth tag, then the ciphertext. The
key is `ENCRYPTION_KEY` decoded from hex, resolved once at module load.

| Stored | Protection |
|---|---|
| OAuth access and refresh tokens for integrations | AES-256-GCM ciphertext |
| Cookie bundles from browser capture | AES-256-GCM ciphertext |
| API keys supplied for `apikey` integrations | AES-256-GCM ciphertext |
| Workbench API keys | bcrypt hash, plus an indexed SHA-256 for lookup, plus an encrypted copy so the owner can re-reveal it |
| MCP OAuth refresh tokens | SHA-256 hex only — the plaintext is never stored |
| Jot passwords | scrypt with a fresh random 16-byte salt per jot, verified in constant time |
| Scopes, expiry timestamps, connection `config` | **Not encrypted** — a self-hosted instance origin or a New Relic region is plaintext |

There is no local account password anywhere in the system. The only scrypt hashes
are jot passwords.

> [!DANGER] There is no key rotation path
> `ENCRYPTION_KEY` is read once at startup and every stored blob is ciphertext
> under it. Changing it does not re-encrypt anything — it makes every existing
> token, cookie bundle, and API key undecryptable, and every user has to reconnect
> every integration. Back it up with at least the care you give the database, and
> keep it identical across every replica and across a
> [database migration](database.md).

Storage guidance is the same for both backends. Older documentation described the
store as "SQLite" and told operators to protect `data/tokens.db`. **PostgreSQL is
a first-class backend.** On a PostgreSQL deployment the equivalent duty is to
restrict network access and role grants on the database, and to protect the
connection string.

## SSRF posture and its limits

Several code paths take a URL that ultimately comes from a user or an agent.

| Path | Control |
|---|---|
| Self-hosted instance URLs for OAuth plugins | `https` only; userinfo rejected; private and loopback literals rejected; path and query dropped, only the origin is kept. On top of that, the origin must be the manifest's cloud default or an entry in `<PLUGIN>_ALLOWED_INSTANCES` |
| `browser_navigate` | Protocol allowlist at the schema layer: only `http:` and `https:`. Added after `file:///proc/self/environ` was found to be readable through the browser tools |
| Tools that fetch a user-supplied URL (e.g. Drive upload-from-URL) | Host validation rejecting RFC-1918 and internal addresses |
| Cookie-auth `ctx.http` | The target host must match the manifest's `targetDomain` or `cookieDomains`; only cookies whose own domain matches the host are sent; redirects are `manual`, so cookies are never replayed across a redirect hop |
| API-key `ctx.http` | If the manifest sets `allowedHosts`, the target host must equal or be a subdomain of an entry, checked **before** the credential is attached |

Two limits to know:

- The private-address check is **literal only, no DNS resolution**. It rejects
  `localhost`, IPv6 loopback/ULA/link-local, and the IPv4 `0.`, `127.`, `10.`,
  `169.254.` (including cloud metadata), `172.16–31.`, `192.168.` ranges. A
  hostname that resolves into one of those ranges is not caught.
- **The OAuth branch of `ctx.http` has no host allowlist at all.** It attaches the
  user's bearer token to whatever URL the plugin passes. The API-key branch has no
  host validation either unless the manifest opts in with `allowedHosts`. This is
  a plugin-trust boundary, not a runtime control — see below.

The one plugin that intentionally reaches an arbitrary host, `slack_download_file`,
allowlists Slack hosts before sending the bearer and drops it on the presigned-CDN
redirect hop.

## The internal-plugin boundary

Two integrations, `browser` and `jots`, are marked internal. Their handlers reach
directly into server modules — the shared browser session and the jots filesystem —
and those modules are deliberately **not** part of the `ToolContext` that
third-party plugins receive. A disk plugin gets `userId`, `getToken()`,
`getConfig()`, and `http()`, and nothing else. It cannot drive the user's browser
or touch the jots store.

The plugin loader enforces the names as well: a directory in `PLUGINS_DIR` called
`browser` or `jots` is skipped with an error, so a dropped-in plugin cannot shadow
an internal capability by taking its name.

That boundary is the reason to treat plugin installation as a privileged
operation. A plugin's `ctx.http` carries the user's live credentials for its own
integration, and on the OAuth branch it chooses the destination. Mount
`PLUGINS_DIR` read-only and review what goes in it.

## Logging

Fastify's logger redacts `Authorization`, `x-workbench-api-key`, `?token=`, and
`?cdpToken=`. `req.url` is deliberately **not** redacted, for traceability — so
avoid putting secrets in query strings and be deliberate about who can read the
logs.

Tool executions are recorded separately in the audit log, which is configurable —
see [observability](observability.md).

## Operator responsibilities

- Protect `ENCRYPTION_KEY` and `SESSION_SECRET`. Losing the encryption key makes
  stored credentials unrecoverable. Disclosing it makes them decryptable.
  Disclosing `SESSION_SECRET` lets an attacker mint any of the five credentials
  derived from it — the four JWTs and the jot unlock cookie.
- Keep the database on trusted storage: restricted filesystem permissions for a
  SQLite file, restricted network and role grants for PostgreSQL.
- Terminate TLS in front of the server, and set `SERVER_PUBLIC_URL` to the
  `https://` origin — the `awb_oauth_binding` login-CSRF cookie only gets its
  `Secure` flag when that value starts with `https://`.
- **Set the portal's own response headers at the proxy.** The server sets security
  headers on exactly two response families: jot responses (a `sandbox` CSP,
  `nosniff`, `X-Frame-Options: SAMEORIGIN`, `Cross-Origin-Resource-Policy`) and the
  OAuth redirect interstitial (its own CSP plus `X-Frame-Options: DENY`). The
  portal SPA, `/api/*`, and `/mcp` get none — no CSP, no HSTS, no frame
  protection. Add `Strict-Transport-Security`, a `Content-Security-Policy`, and a
  frame-ancestors or `X-Frame-Options` policy in front of the server.
- Treat `/metrics` as internal. It is unauthenticated.
- Rate-limit `POST /register` at the proxy on an internet-facing deployment.
- Rotate per-plugin OAuth client secrets on your own schedule. The server reads
  them from the environment and never stores them.
- Review anything you put in `PLUGINS_DIR`, and mount it read-only.
- Remember that `BROWSER_PROFILE_TTL_DAYS` (default 30) **deletes** an idle
  browser profile, logging that user out of every cookie-auth integration.
