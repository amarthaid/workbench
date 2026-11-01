# 2026-11-01 security report fixes

An external black-box + source review (`workbench-security-report.md`,
31 Oct 2026) against a production deployment found seven confirmed
weaknesses, two of which (findings 1 and 3) composed into a complete
account-compromise chain: an unauthenticated attacker could register an
OAuth client, send a signed-in employee one link, receive an authorization
code with no consent action, and then read every vault secret in plaintext
through the agent-facing `vault_presign` tool. This note records the fix
for each.

## 1. Silent OAuth consent + open redirect-URI registration

`POST /register` accepted any `redirect_uris` (including `javascript:`,
`data:`, relative, and arbitrary external HTTPS origins), and the portal's
`/authorize/choose` page auto-submitted the resume form for an
already-signed-in human with no approve/deny action — a session was treated
as consent.

Fix: `isAllowedRedirectUri` (`auth/oauth-server/clients.ts`) restricts
registration to `https:` or loopback `http:`. The consent page
(`AuthorizeChoose.tsx`) now fetches `GET /authorize/info` (read-only, never
consumes the ticket) and renders the requesting client's name and
destination origin, requiring an explicit Approve click before the hidden
form ever submits.

## 2. Integration connect flow not bound to the initiating browser

`GET /api/auth/:integration` (plugin OAuth) and the custom-app equivalent
minted a provider URL under the *caller's* `user_id`, with nothing tying
the eventual callback to that same browser — the provider's consent screen
only ever named the workbench application, so a second user could start the
flow and have a victim's approval stored under the attacker's account.

Fix: a fresh `makeBinding()` value rides the otherwise-unused `nonce`
column on the `pending_auth` row (see `auth/oauth.ts`'s `bindingMatches`)
and an HttpOnly, path-scoped cookie (`auth/connect-cookie.ts`), checked at
the callback before any token exchange — mirroring the existing
`awb_oauth_binding` pattern on the MCP authorization server. Applied to
both the plugin-OAuth flow (`auth/plugin-oauth.ts`) and custom apps
(`custom-apps/oauth.ts`).

## 3. Agent credential could mint a vault secret's plaintext link

`vault_presign` was registered as a normal `auth: {type: "none"}` MCP tool
even though the vault's whole design is "use without read" — any MCP
client or API key holder could `vault_list` then `vault_presign` every
secret and `POST` the resulting one-time URL (which needs no credential)
for the plaintext.

Fix: removed `vault_presign` from the agent-facing tool registry
(`plugins/internal/vault.ts`). The only mint path left is the
portal-session-gated `POST /api/vault/otl` route.

## 4. Unauthenticated `/metrics`

Served Prometheus process/app metrics — including the full internal route
table and per-integration tool-execution counters — to anyone, no
credential.

Fix: `registerMetricsRoute` (`telemetry/metrics-route.ts`) 404s unless
`config.METRICS_TOKEN` is set and the request carries a matching
`Authorization: Bearer` (timing-safe compare). 404 on every failure path
(unconfigured, missing, wrong) so an anonymous caller learns nothing about
the route's existence.

## 5. Redirect-following SSRF in `google_drive_upload_from_url`

The tool validated the literal host of the caller-supplied URL once, then
called `fetch()` with default redirect-following — a public HTTPS endpoint
answering `302` to an internal address was followed silently, and the
response body landed in the caller's Drive.

Fix: `fetchFollowingSafeRedirects` (`plugins/google-drive/tools/drive.ts`)
follows redirects manually (`redirect: "manual"`), re-validates every hop
against the same private/loopback check, requires https on every hop, and
caps hops at 5.

## 6. Session fixation via URL-fragment token adoption

The portal's boot logic adopted any `#token=` value from the URL
unconditionally — an attacker could complete their own real login, then
send a victim `.../#token=<attacker's own valid token>`; the victim's
browser silently adopted it, and anything the victim subsequently saved
landed in the attacker's account.

Fix: a login-ceremony nonce (`login-nonce.ts`) is generated client-side and
stashed in `sessionStorage` immediately before redirecting to the SSO
provider; the server persists it alongside the OAuth state (the `config`
column, otherwise unused on SSO rows) and echoes it back on the final
`#token=...&nonce=...` redirect. `AuthContext.tsx`'s `readBootToken` now
refuses to adopt a fragment token whose nonce doesn't match what this exact
tab stored — a value sessionStorage never saw (because this tab never
started that login) can't be forged by a URL.

## 7. SSRF guard missed the IPv6 unspecified address

`isPrivateHost`/`isBlockedHost` enumerated loopback and private-range
literals but had no case for `::` / `[::]` (or the fully-expanded zero
form) — Linux treats `connect()` to the unspecified address as resolving to
the local host, so it reached exactly what the loopback block exists to
stop (CDP, admin, metrics).

Fix: added `::`, `[::]`, `0:0:0:0:0:0:0:0`, `[0:0:0:0:0:0:0:0]` to
`isPrivateHost` (`auth/plugin-oauth.ts`) — the single check both
`normalizeBaseUrl` and `safeFetch`'s resolved-address guard share.

## Not fixed here

Finding 3.6's open item on server-side session revocation (stateless
24h tokens, no revocation list) and the password-gated artifact route's
rate limiting are tracked in the report's Open Items but weren't exercised
live (no reachable artifact, no revocation primitive to test against) —
left for a follow-up pass.
