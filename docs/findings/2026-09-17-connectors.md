# Connectors: registering external MCP servers per user

Feature: register an external MCP server (HTTP streamable, OAuth 2.1) in the
portal; its tools surface through this app's own `search_tools` / `execute_tools`,
never as a passthrough endpoint.

## Per-user tools can't live in the static registry

The plugin `registry` is a module-level singleton loaded once at boot. Connectors
are per-user, dynamic, DB-backed, so they need a parallel resolution path
(`src/connectors/index.ts`) keyed by `userId`, which `search_tools`,
`get_tool_schema`, `executeSingle` and `list_integrations` all consult *after*
the static registry misses. Tool names are `connectorName__remoteTool`; the
`__` separator is what keeps them out of the flat built-in namespace.

## OAuth is MCP's spec flow, not the plugin env-cred flow

Built-in plugins read a static client id/secret from env. A connector pastes
only a base URL; the server discovers `/.well-known/oauth-authorization-server`
(authorize/token/registration endpoints + scopes) and
`/.well-known/oauth-protected-resource` (the `resource` indicator), then does
RFC 7591 dynamic client registration. **Well-known paths are host-rooted** — build
them from `new URL(baseUrl).origin`, not the (possibly path-qualified) base URL.

Token auth honours the registration response's `token_endpoint_auth_method`
(`client_secret_basic` → Basic header, otherwise `client_secret_post`), and
`resource` is sent on both the authorize and token/refresh requests. The client
id/secret live on the `connectors` row (secret encrypted); the OAuth access and
refresh tokens reuse the existing `connections` table under
`integration = connector:<id>`.

## No local arg validation (Claude Desktop parity)

Connector tools carry JSON Schema from the remote server, not Zod. Args pass
through unvalidated and the remote server rejects bad ones — matching Claude
Desktop, and avoiding a lossy JSON Schema → Zod conversion. Image content blocks
are dropped to a marker (the base64 would bloat context and the `_mcpImage`
renderer only surfaces one image per result node anyway).

## encryption.ts load-time side effect broke config-mocked tests

`src/auth/encryption.ts` computed `Buffer.from(config.ENCRYPTION_KEY, "hex")` at
module load. Importing it through a new graph (connectors/store → encryption)
reached two suites that `vi.mock("../src/config", …)` without an
`ENCRYPTION_KEY` field, and `Buffer.from(undefined)` threw at import time. Fix =
compute the key lazily inside `encrypt`/`decrypt` (memoized), so importing the
module is always safe. General lesson: keep `config` reads out of module-load
side effects.

## Vite dev proxy `/c` is a raw prefix match

The portal's dev proxy forwards `/c` to the server for the curl proxy
(`/c/<integration>/<path>`). http-proxy matches a bare `/c` as a raw path
prefix, so it was also swallowing every SPA route starting with `c` —
`/connect/:integration` (fresh loads 404'd all along) and the new
`/connectors`. The OAuth callback redirect to `/connectors?status=…` is a
top-level navigation, so it would have hit that 404 too. Fix = `/c/` (curl
proxy paths always carry a trailing segment), which also restored the
pre-existing `/connect/:integration` fresh-load.

## Still open

- Smoke-tested the full loop against a mock MCP+OAuth server
  (discovery → registration → PKCE → token → tools/list → tools/call), green;
  a real provider is still untested.
- SSRF guard is literal-only (DNS-resolved private hosts pass), same ceiling as
  the plugin instance allowlist.
