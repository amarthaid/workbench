# Custom apps: static header auth

## Goal

Let a user register a custom MCP app by URL plus static request headers (API key,
`X-Api-Key`, custom `Authorization`), with no OAuth step. OAuth apps keep working
unchanged.

## Success criteria

- User adds an app in the portal with one or more headers; `search_tools` /
  `execute_tools` work against it immediately.
- Header values are encrypted at rest and never returned by any API, logged, or
  echoed in an error.
- A bad key fails at create time with a clear error, not as a silently dead app.
- Existing OAuth custom apps behave exactly as before.

## Non-goals

- Per-header "plain vs secret" distinction. Every value is treated as secret.
- Header templating or per-call header overrides.
- Migrating existing OAuth apps to header auth.

## Design

### Storage

- `custom_apps` gains a nullable `headers_enc` column (`BLOB` on SQLite,
  `BYTEA` on PostgreSQL), added via the existing idempotent schema path for both
  backends. It holds `encrypt(JSON.stringify([{name, value}]))`.
- `CustomAppMetadata` gains `authType?: "oauth" | "headers"`; absent means
  `"oauth"` so existing rows are unaffected.
- `CustomApp` gains `headers?: {name: string; value: string}[]` (decrypted,
  in-memory only), populated by `toCustomApp`.
- No `connections` row is written for header apps.

### Auth resolution

- `ensureCustomAppToken(userId, app)` (returns a bearer string) is replaced at the
  call sites by `resolveAuthHeaders(userId, app): Promise<Record<string,string>>`:
  - `oauth`: `{ Authorization: "Bearer <token>" }` via the existing token logic.
  - `headers`: the decrypted header list as a record.
- `client.ts` `discoverTools` / `callRemoteTool` / `getSession` take the headers
  record instead of a token string. The session cache compares a SHA-256
  fingerprint of the record (not the plaintext) so rotating a key closes the old
  session, as a token refresh does today. Both the streamable and SSE-fallback
  transports send the same headers.
- `discover()` in `custom-apps/index.ts` calls `resolveAuthHeaders`; no OAuth
  discovery, DCR, or refresh runs for header apps.

### Validation (create and update)

- Name: RFC 7230 token (`^[!#$%&'*+.^_`|~0-9A-Za-z-]+$`), case-insensitive unique.
- Value: non-empty, no CR/LF/NUL, at most 4 KB. At most 10 headers.
- Deny-list (case-insensitive): `Host`, `Content-Length`, `Content-Type`, `Accept`,
  `Mcp-Session-Id`, `X-Workbench-Via`, `Connection`, `Transfer-Encoding`, `Upgrade`,
  `Keep-Alive`, `TE`, `Trailer`, `Proxy-Authorization`, `Proxy-Connection`.
  Workbench owns these or they break the transport.
- Create-time verify: connect and `tools/list` with the supplied headers through
  the existing `safeFetch` / loop-guard path. On failure return 400 with the
  upstream status only (never the headers). Nothing is persisted on failure.
- The existing SSRF check, self-loop refusal, and `customAppsAllowedFor` policy
  apply to header apps unchanged.

### API

- The create route accepts `{ name, baseUrl, authType: "headers", headers: [...] }`.
  `authType` defaults to `"oauth"`, preserving the current request shape.
- Responses list header **names only** (`headerNames: string[]`), never values.
- Update: a header supplied with an empty/omitted value keeps its stored value;
  names absent from the request are removed. Re-verify on any change.
- Delete: removes the row (headers go with it); the `connections` delete is a
  harmless no-op for header apps.

### Portal

- Add-app form gets an auth toggle (OAuth / Headers). Headers mode shows a
  repeatable name + masked value row (add/remove), client-side mirroring the
  server limits. Edit shows names with value fields blank ("unchanged").
- Header apps show as connected immediately (no connect step); a failed verify
  surfaces the 400 message inline.

### Error handling

- Upstream 401/403 on a header app at call time maps to a clear
  "check the app's headers" tool error, not a reconnect prompt (there is nothing
  to reconnect).
- The admin "needs reconnect" derivation must not flag header apps.
- Decryption failure degrades like corrupt metadata: the app yields no tools this
  cycle; it must not throw out of discovery.

### Testing

- Store: round-trip encrypt/decrypt, names-only exposure, legacy rows (no
  `headers_enc`, no `authType`) still load as OAuth.
- Validation: bad names, CRLF values, deny-listed names, size/count caps.
- Client: headers sent on both transports; fingerprint change evicts the session;
  no plaintext in logs or errors.
- Routes: create verifies before persisting, 400 on upstream failure, update keeps
  blank values, responses never contain values.
- Discovery: header app skips OAuth path; OAuth app unchanged (regression).
- Portal: toggle, masked input, names-only edit, inline error.

## Public-repo hygiene

Fixtures use synthetic values only (`X-Api-Key`, `tok-abc`, `example.com`).
After implementation, record a findings doc and add it to the CLAUDE.md index.
