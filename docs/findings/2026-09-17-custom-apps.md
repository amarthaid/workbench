# Custom apps: registering external MCP servers per user

Feature: register an external MCP server (HTTP streamable, OAuth 2.1) as a
per-user **custom app**, modeled as an App beside the native apps. Its tools
surface through this app's own `search_tools` / `execute_tools`, never as a
passthrough endpoint.

## Per-user tools can't live in the static registry

The plugin `registry` is a module-level singleton loaded once at boot. Custom
apps are per-user, dynamic, DB-backed, so they need a parallel resolution path
(`src/custom-apps/index.ts`) keyed by `userId`, which `search_tools`,
`get_tool_schema`, `executeSingle` and `list_integrations` all consult *after*
the static registry misses. Tool names are `appName__remoteTool`; the `__`
separator is what keeps them out of the flat built-in namespace.

## OAuth is MCP's spec flow, not the plugin env-cred flow

Built-in plugins read a static client id/secret from env. A custom app pastes
only a base URL; the server follows the 401 `WWW-Authenticate` challenge to the
protected-resource metadata, then its `authorization_servers` to the AS metadata
(authorize/token/registration endpoints + scopes), then does RFC 7591 dynamic
client registration. **Well-known paths are host-rooted** when there's no
challenge — build them from `new URL(baseUrl).origin`, not the (possibly
path-qualified) base URL.

Token auth honours the registration response's `token_endpoint_auth_method`
(`client_secret_basic` → Basic header, otherwise `client_secret_post`, defaulting
to `client_secret_basic` per RFC 7591), and `resource` is sent on both the
authorize and token/refresh requests. The client id/secret live on the
`custom_apps` row (secret encrypted); the OAuth access and refresh tokens reuse
the existing `connections` table under `integration = custom:<id>`.

Real-provider gotcha (Notion `https://mcp.notion.com/mcp`): with
`client_secret_basic` the credentials go **only** in the Basic header — sending
`client_id` in the body too is rejected as `invalid_request: "Client must not
use multiple authentication methods"`.

## No local arg validation (Claude Desktop parity)

Custom app tools carry JSON Schema from the remote server, not Zod. Args pass
through unvalidated and the remote server rejects bad ones — matching Claude
Desktop, and avoiding a lossy JSON Schema → Zod conversion. Image content blocks
are dropped to a marker (the base64 would bloat context and the `_mcpImage`
renderer only surfaces one image per result node anyway).

## SSRF: every discovered endpoint is attacker-influenced

The AS/resource metadata endpoints (registration, token, authorization) and each
redirect hop are validated with `assertSafeUrl`/`safeFetch` — http(s) only, no
embedded creds, non-private host. `safeFetch` uses `redirect: "manual"` and
rejects a 3xx rather than following it to an internal host. `isPrivateHost`
handles IPv4-mapped IPv6 (`[::ffff:a9fe:a9fe]` = 169.254.169.254), and loopback
is allowed only outside production.

## Schema: `custom_apps` + a pre-release migration

The feature first landed on this branch as a `connectors` table with
`connector:<id>` integration keys, then was renamed to custom apps. The rename
ships with a migration (`migrateConnectorsToCustomApps` in `db.ts`): copy
`connectors` → `custom_apps`, drop `connectors`, rewrite `connector:<id>` →
`custom:<id>` in `connections` and `audit_log`. Two gotchas that matter even for
pre-release data:

- Copy keyed on (user, name) and **skip** rows whose name already exists —
  otherwise the `UNIQUE(user_id, name)` constraint throws when a user re-created
  the app under a new id mid-rename (the first cut crashed the server on exactly
  that).
- After the rewrite, **delete** any `connector:<id>` row whose id no longer maps
  to a `custom_apps` row — a re-created app leaves an orphaned reference, and
  leaving it leaks the raw key onto the Home page's "Most used app" stat.

## encryption.ts load-time side effect broke config-mocked tests

`src/auth/encryption.ts` computed `Buffer.from(config.ENCRYPTION_KEY, "hex")` at
module load. Importing it through a new graph (custom-apps/store → encryption)
reached two suites that `vi.mock("../src/config", …)` without an
`ENCRYPTION_KEY` field, and `Buffer.from(undefined)` threw at import time. Fix =
compute the key lazily inside `encrypt`/`decrypt` (memoized), so importing the
module is always safe. General lesson: keep `config` reads out of module-load
side effects.

## Vite dev proxy raw-prefix matches

The portal's dev proxy forwards server-owned paths with raw-prefix matching, so
`/c` swallowed every SPA route starting with `c` (e.g. `/connect/:integration`,
fresh loads 404'd all along), and `/authorize` swallowed the portal's
`/authorize/choose` page (breaking the MCP OAuth flow). Fix = `/c/` and
`^/authorize(?:/resume)?$` (exact matches only).

## Still open

- Smoke-tested the full loop against a mock MCP+OAuth server
  (discovery → registration → PKCE → token → tools/list → tools/call), green;
  a real provider (Notion) connected and ran tools.
- SSRF guard is literal-only (DNS-resolved private hosts pass), same ceiling as
  the plugin instance allowlist.
