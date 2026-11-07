# Spaces: live, shareable apps over a viewer's own integrations

## Problem

Jots are static. A jot is a snapshot: whatever data the agent baked into it at
deploy time. Users want the same "agent builds a web page" flow, but for pages
that stay live and act on integrations:

- A timeline of my open GitHub PRs and Bitbucket PRs, fetched when I open it.
- A form that uploads a file to my Google Drive.
- A dashboard that joins two integrations (a Sheet and a metrics tool) on view.

Sharing has to be relative to the viewer. When a teammate opens the same Space,
it calls *their* connections and shows *their* PRs.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Viewer consent | Approve once per Space for its tool list, plus a confirmation for every `destructive` call. The author cannot turn the confirmation off. |
| 2 | Where a tool's effect comes from | The plugin declares `effect: "read" \| "write" \| "destructive"` on each tool. An unlabelled tool is treated as `destructive`. `/mcp` surfaces it as MCP `readOnlyHint` / `destructiveHint`. |
| 3 | Who can open a Space | The author picks `private`, `org` (any signed-in user of the deployment) or `users` (an email list). A portal gallery lists the Spaces you can open. |
| 4 | Reuse | Reuse means sharing (3). No remix, no per-viewer settings. |
| 5 | Storage | Stateless over integrations, plus a small per-viewer key-value store. |
| 6 | Relation to Jots | A separate internal `spaces` plugin that reuses Jot's tarball extraction and path guards. |
| 7 | Bridge | Every call goes through a trusted shell via `postMessage`. The Space never holds a credential. |

## Non-goals (v1)

- Shared (cross-viewer) state, remix/fork, per-viewer settings.
- Custom-app tools (`custom:*`) inside Spaces. Registry tools only.
- Server-side declared queries, caching, scheduled refresh.
- Public (signed-out) Spaces. A Space always runs as a signed-in viewer.

## Architecture

```
 browser, portal origin                                  server
 ┌───────────────────────────────────────────┐
 │ /s/<name>   Shell (portal React route)      │  GET  /api/spaces/:name
 │  - viewer's portal JWT (localStorage)       │  POST /api/spaces/:name/consent
 │  - consent screen, confirm modal, banners   │  POST /api/spaces/:name/call ──► executeSingle
 │  ┌───────────────────────────────────────┐  │  GET/PUT/DELETE /api/spaces/:name/kv/:key
 │  │ iframe sandbox="allow-scripts         │  │
 │  │   allow-forms"                        │  │  GET  /s/:name/app/<sig>/*  (author files,
 │  │ src=/s/<name>/app/<sig>/              │  │        strict CSP, opaque origin)
 │  │ Space code + /s/_sdk/workbench.js     │  │  GET  /s/_sdk/workbench.js
 │  └──────────── postMessage ──────────────┘  │
 └───────────────────────────────────────────┘
```

### Why a shell and not the portal session

The portal session can do anything the viewer can: every tool, the vault,
API-key minting, and `/api/admin/*` for admins. Space code is uploaded at runtime
by any user. Giving it the session would make the tool list and the consent
screen advisory. The shell keeps the viewer's identity (calls run as them, with
their connections) and narrows the Space's authority to its declared tools.
Destructive-call confirmation also needs UI the Space cannot draw or click, which
only a page outside the iframe can provide.

### Serving author files

`GET /s/:name/app/<sig>/*path` serves the Space's files. The iframe is sandboxed,
so it sends no credential; access is carried by `sig` in the path instead:
`sig = base64url(exp) + "." + base64url(userId) + "." + base64url(HMAC-SHA256(SESSION_SECRET, "space-app|" + name + "|" + userId + "|" + exp))`
(the user id travels in the sig because the credential-less iframe request
carries nothing else that names the viewer)
with `exp` about 12 hours out, minted by `GET /api/spaces/:name` for a viewer who
has access. Relative URLs inside the Space resolve under the same prefix. A bad
or expired `sig` returns 404. Revoking someone's share does not kill an already
minted `sig` before it expires; it only exposes the Space's own files, never data.

Every response carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms;
  default-src 'none';
  script-src 'self' <origins> 'unsafe-inline' 'unsafe-eval';
  style-src 'self' <origins> 'unsafe-inline';
  img-src 'self' <origins> data: blob:;
  font-src 'self' <origins> data:;
  media-src 'self' <origins> data: blob:;
  connect-src 'none';
  form-action 'none';
  frame-src 'none';
  base-uri 'none';
  frame-ancestors <origins>
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: cross-origin
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

`<origins>` is the origin of `SERVER_PUBLIC_URL` and the origin of
`PORTAL_URL`, deduplicated (one origin when they are equal). The portal origin
is needed because the portal embeds the frame and the relative `appUrl` (and
the SDK) are fetched through it, e.g. the Vite dev server or a split
deployment. They are spelled out next to `'self'` because `'self'` inside a
sandboxed (opaque-origin) document is not reliably matched by every browser. No remote hosts are allowed anywhere: a remote
`img-src` or `script-src` is an exfiltration channel. Authors bundle or inline
every dependency.

`Cross-Origin-Resource-Policy` is `cross-origin` on purpose: the document is
opaque-origin, so every subresource load (its own `<script src>`, images, CSS)
is cross-origin no-cors, and `same-origin` would block them. The `sig` in the
path is the access control. `allow-forms` stays: without it the browser
cancels form submission before the `submit` event fires, so the ordinary
`<form>` plus `addEventListener("submit", e => e.preventDefault() ...)` pattern
never runs (found in the local end-to-end run). `form-action 'none'` is what
blocks a real form navigation, so keeping `allow-forms` opens no exit.

No server route is registered for `/s/:name` or `/s/:name/` (unlike jots'
`/j/:name` redirect): those paths fall through to the portal SPA, which owns
the shell. The server owns only `/s/_sdk/*`, `/s/upload/:token` and
`/s/:name/app/<sig>/*`. The names `_sdk` and `upload` are reserved. In dev,
Vite proxies exactly those three patterns to the server. The app route is
registered as `/s/:name/app/*` and takes `sig` as the first segment of the
wildcard tail, not as a `:sig` param, so find-my-way's 100-character
`maxParamLength` never applies to it whatever the user id's length.

`jot.json`-style manifest blocking is not needed (the manifest lives in the
database), but the same traversal guards apply.

### Residual risk

A sandboxed iframe can still navigate itself to an outside URL, and no shipped
CSP directive blocks that. A malicious author could leak data in that URL, and
the new document would keep the same `contentWindow`. So the bridge never
trusts `contentWindow` after the handshake: on the iframe's first `load` the
shell creates a `MessageChannel`, posts `port2` to the frame once, and from
then on reads requests from and writes replies to `port1` only. A later
document never gets a port, so it can neither issue calls nor receive in-flight
replies. The shell also treats any second `load` as a navigation, unmounts the
frame and shows "This Space navigated away and was stopped".

What remains: data put in the navigation URL itself has left, a navigation
before the first `load` (before the port exists) carries nothing because no
call could have run yet, and DNS prefetch is not governed by CSP, which leaves a
small DNS channel. Spaces are therefore exfiltration-resistant, not
exfiltration-proof. Mitigations: authors are signed-in members, consent lists
every tool, every call is audited with the Space's name, admins can delete any
Space.

## Tool effect labels

`ToolDefinition` (packages/shared) carries `effect?: "read" | "write" | "destructive"`
(the field exists; this work completes coverage and adds the test).

- `read`: no change to anything (list, get, search, download).
- `write`: creates or edits, recoverable or additive (create issue, comment,
  upload, create draft, update a cell).
- `destructive`: deletes, overwrites, irreversible or outward-facing on the
  user's behalf (delete, trash, merge, close, send email, post Slack message,
  change permissions, overwrite a file).

`effectOf(tool) = tool.effect ?? "destructive"`. Every built-in plugin and
internal plugin tool is labelled; a test asserts that every built-in tool has an
explicit label. `search_tools` / `get_tool_schema` include `effect`, and the
schema output includes `annotations: { readOnlyHint, destructiveHint }`.

## Data model

Both dialects, created in `applySchema`.

```sql
CREATE TABLE IF NOT EXISTS spaces (
  name TEXT PRIMARY KEY,           -- same rules as jot names
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  tools TEXT NOT NULL,             -- JSON array of fully-qualified tool names, sorted, deduped
  visibility TEXT NOT NULL,        -- 'private' | 'org' | 'users'
  created_at INTEGER NOT NULL,     -- epoch ms
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS space_shares (
  space_name TEXT NOT NULL,
  email TEXT NOT NULL,             -- lowercased
  PRIMARY KEY (space_name, email)
);
CREATE TABLE IF NOT EXISTS space_consents (
  space_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  tools_hash TEXT NOT NULL,        -- sha256 of the sorted tool list JSON
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (space_name, user_id)
);
CREATE TABLE IF NOT EXISTS space_kv (
  space_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,               -- 1..128 chars
  value TEXT NOT NULL,             -- JSON, <= 64 KiB
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_name, user_id, key)
);
```

Per viewer per Space the KV store holds at most 256 KiB in total. Deleting a
Space deletes its shares, consents, KV rows and files.

Files live on disk at `SPACES_DIR` (default: `spaces/` next to the SQLite file,
like `jots/`). Limits reuse `JOTS_MAX_BYTES` / `JOTS_MAX_FILES`. The archive root
must contain `index.html`.

## Access rule

`canView(space, viewer)`: owner, or `visibility = 'org'`, or
`visibility = 'users'` and the viewer's email (lowercased) is in `space_shares`.
Admins can list and delete every Space but cannot *open* one they were not
shared on (opening runs code as them, which is not an admin power). Every
endpoint answers 404 when `canView` is false, so names cannot be probed.

## Agent tools (internal plugin `spaces`, auth none)

| Tool | Effect | Behaviour |
|---|---|---|
| `deploy_space` | write | `{ name, title, description?, tools: string[], visibility, users?: string[] }`. Validates the name (jot rules, and not the reserved `_sdk` / `upload`), ownership (`SPACE_NAME_TAKEN`), each tool exists in the registry and belongs to an external plugin, never an internal one (`browser`, `jots`, `files`, `vault`, `spaces`) and never a custom app, checked by `tool.integration`, not by name (`TOOL_NOT_ALLOWED`); `users` required when visibility is `users`. Upserts metadata immediately, mints an upload token. Returns `{ uploadUrl, token, expiresAt, maxBytes, url }`. A brand-new Space is not visible until its first upload lands. |
| `update_space` | write | `{ name, title?, description?, tools?, visibility?, users?, files?: boolean, delete?: string[] }`. Metadata changes apply now. When `files` is true (or `delete` is given), mints a patch upload token like `update_jot`. Changing `tools` changes the hash, so every viewer is asked again. |
| `list_spaces` | read | `{ all?: boolean }`. Own Spaces; `all` (admins only) lists every Space. Rows: name, title, visibility, tools, url, updatedAt, owner email when `all`. |
| `list_space_files` | read | `{ name }`, owner only. |
| `delete_space` | destructive | `{ name }`. Owner or admin. |

Upload: `POST /s/upload/:token` with `application/gzip`, same flow, limits and
error codes as `/j/upload/:token`. Tokens live in `pending_auth` under the
sentinel `__space_upload__`.

The tool description tells the agent how to write a Space: include
`<script src="/s/_sdk/workbench.js"></script>`, call `workbench.call(...)`,
bundle every asset, no network access.

## Portal API (portal session JWT only)

API keys and OAuth tokens are refused on these routes (401). Only a human in the
portal shell may drive a Space. Auth reads `Authorization: Bearer` and
`verifySession` only, ignoring `x-workbench-api-key` (the shared
`authenticate()` prefers an API key, so it is not used), in a scope-level
`preHandler` that also calls `noteRequestAuth(request, "session")`, like the
admin scope. All bodies are JSON.

### `GET /api/spaces`
`{ spaces: [{ name, title, description, ownerEmail, visibility, updatedAt, mine }] }`:
every Space the viewer can open, newest first.

### `GET /api/spaces/:name`
```json
{
  "name": "pr-timeline", "title": "PR timeline", "description": "…",
  "ownerEmail": "dev@example.com", "mine": true,
  "visibility": "org", "users": [],
  "updatedAt": 1700000000000,
  "tools": [
    { "name": "github_list_prs", "integration": "github", "integrationName": "GitHub",
      "effect": "read", "connected": true, "description": "…" }
  ],
  "consented": true,
  "appUrl": "/s/pr-timeline/app/<sig>/"
}
```
`users` is only returned to the owner. A declared tool that no longer exists in
the registry (plugin removed or disabled) is returned with `"missing": true`.

### `POST /api/spaces/:name/consent`
Records consent for the current tool hash. `{ ok: true }`.

### `DELETE /api/spaces/:name/consent`
Revokes. `{ ok: true }`.

### `POST /api/spaces/:name/call`
Body `{ tool, args?, confirmed? }`. Order of checks:

1. Viewer can open the Space, else 404.
2. Consent row exists with the current hash, else 403 `CONSENT_REQUIRED`.
3. `tool` (fully-qualified, or bare suffix resolved like `/rest`) is in the
   Space's tool list, else 403 `TOOL_NOT_DECLARED`.
4. Tool exists in the registry, else 404 `TOOL_UNAVAILABLE`.
5. `effectOf(tool) === "destructive"` and `confirmed !== true`: 428
   `CONFIRMATION_REQUIRED`. The trust boundary is the shell, not this flag:
   anyone holding a portal session can send `confirmed: true`, and that is
   fine because that is the viewer acting directly. What matters is that the
   shell never forwards a `confirmed` supplied by the Space; it sets the flag
   only after its own modal returns Allow.
6. Any string anywhere in `args` containing `{{vault:`: 400 `INVALID_ARGS`.
   The call then runs `executeSingle` with an empty pre-substituted map, so
   vault references are never resolved for a Space. Otherwise a Space could put
   `{{vault:prod_token}}` in a comment body and ship the viewer's secret
   upstream.
7. Rate limit: 60 calls per minute per (viewer, Space), in-process token bucket.
   Over: 429 `RATE_LIMITED` with `retryAfterMs`. Per process, so approximate
   under `CLUSTER_ENABLED` or several replicas.
8. `executeSingle(viewerId, tool, args, new Map())`, after setting
   `client_name = "space:<name>"` on the current request's audit store (the
   handler already runs inside one).

Outcome mapping: result: 200 `{ result }`. `NOT_CONNECTED`: 409
`{ code: "NOT_CONNECTED", integration }`. Invalid arguments: 400
`{ code: "INVALID_ARGS", message }`. Anything else: 502
`{ code: "UPSTREAM_ERROR", message }`. Every non-200 body has
`{ code, message, integration?, tool? }`.

### `GET /api/spaces/:name/kv` and `GET|PUT|DELETE /api/spaces/:name/kv/:key`
Per-viewer store. `GET /kv` returns `{ keys: string[] }`. `GET /kv/:key` returns
`{ value }` or 404 `{ code: "KEY_NOT_FOUND" }` for a key that is not set,
distinct from the Space-level 404 `{ code: "NOT_FOUND" }` (Space gone or not
shared), which the shell surfaces as an error. `PUT` body `{ value }` (any
JSON), 413 `{ code: "TOO_LARGE" }` over the limits. Requires access and consent
(403 otherwise). KV requests share the `/call` rate-limit bucket (429
`RATE_LIMITED`). The key is the wildcard tail of the path, so keys up to 128
characters pass the router's 100-character param cap.

## SDK (`/s/_sdk/workbench.js`)

A dependency-free script served by the server with a long cache and the same
strict headers as Space files. It defines `window.workbench`:

```ts
workbench.call(integration: string, tool: string, args?: object): Promise<unknown>
workbench.me(): Promise<{ email: string }>   // answered by the shell from its /api/auth/me data
workbench.store.get(key): Promise<unknown | undefined>
workbench.store.set(key, value): Promise<void>
workbench.store.delete(key): Promise<void>
workbench.store.keys(): Promise<string[]>
```

No `batch` and no `connected` event in v1: parallel `call`s cover batching, and
batching complicates the confirm flow; the connect banner covers reconnects.

Rejections are `WorkbenchError` instances with `code`, `message`, `integration`,
`tool`. Codes: `TOOL_NOT_DECLARED`, `TOOL_UNAVAILABLE`, `NOT_CONNECTED`,
`DENIED`, `INVALID_ARGS`, `UPSTREAM_ERROR`, `RATE_LIMITED`, `UNAUTHENTICATED`,
`CONSENT_REQUIRED`, `TOO_LARGE`, `TIMEOUT`.

`workbench.call("github", "list_prs", …)` accepts the bare suffix; the full name
also works.

### Wire protocol

Handshake: on the iframe's first `load`, the shell creates a `MessageChannel`
and posts `{ __wb: 1, type: "port" }` with `port2` transferred, to
`iframe.contentWindow` with target origin `"*"` (the Space's origin is opaque).
That is the only message ever posted to `contentWindow`. The SDK accepts the
port only from `event.source === window.parent`, only once, and queues calls
made before it arrives.

Over the port, Space to shell: `{ __wb: 1, id, type, payload }` with type `call`
(`{ integration, tool, args }`), `me`, `kv.get`, `kv.set`, `kv.delete`,
`kv.keys`. Shell to Space: `{ __wb: 1, id, ok: true, result }` or
`{ __wb: 1, id, ok: false, error: { code, message, integration?, tool? } }`.
Any `confirmed` field in a request is ignored. Each call times out in the SDK
after 120 s (`TIMEOUT`).

## Shell (portal route `/s/:name`)

Full-screen, inside `RequireAuth`, outside the main layout.

1. `GET /api/spaces/:name`. 404: "This Space does not exist or was not shared
   with you."
2. Not consented: consent screen. Groups tools by integration, each tagged
   Reads / Writes / Asks first (`destructive`), flags integrations not
   connected and missing tools. Approve calls `POST consent`, then mounts.
3. Thin top bar: title, "by ownerEmail", "Running as you", menu: View tools,
   Revoke access (DELETE consent, back to the consent screen).
4. Iframe: `sandbox="allow-scripts allow-forms"`, `allow=""`,
   `referrerpolicy="no-referrer"`, `src=appUrl`.
5. Bridge: handles messages per the protocol. The shell decides the effect
   from its own `GET /api/spaces/:name` data; a tool marked `missing` or with
   an unknown effect counts as `destructive`. `call` with a `destructive` tool
   opens the confirm modal first (queued, one at a time); Deny yields `DENIED`.
   More than 5 confirmation requests in 10 s pauses the Space with a notice.
   A 428 from the server (the shell's view was stale) is handled the same way:
   modal, then retry with `confirmed`. 409 adds a non-blocking
   "Connect <Integration>" banner linking to `/apps/:integration` in a new
   tab. 403 `CONSENT_REQUIRED` mid-session (the author changed the tool list)
   unmounts the frame and returns to the consent screen. 401 from the API:
   redirect to login with return path.
6. Second iframe `load` event: unmount and show the navigated-away notice.

## Gallery (portal route `/spaces`)

A nav entry "Spaces". Cards from `GET /api/spaces`: title, description, owner,
visibility badge, updated time, "Yours" badge. Empty state explains that Spaces
are created by asking an agent, with an example prompt.

## Audit

`AuditRequestContext` gains `client_name?: string`. When set, both places that
derive a name from `client_id` (the logger and `requestLogFields`) use it
instead. `/api/spaces/:name/call` sets it to
`space:<name>`. No schema change: `audit_log.client_name` already exists, so the
Activity page shows which Space made the call.

## Testing

Server (vitest, `packages/server/tests/spaces/`):
- store: CRUD, tool hash stable under reordering, cascade delete.
- access: private / org / users, email case, admin cannot open unshared.
- plugin tools: validation errors, ownership, disallowed tools, admin delete,
  list `all` admin-only.
- routes: upload flow, app file serving with valid / bad / expired / other-user
  `sig`, CSP header exact, traversal, SDK served.
- API: every step of the call check order, 428 then success with `confirmed`,
  `{{vault:` refused, rate limit, API key refused, KV limits, consent
  invalidated by tool change, audit `client_name`.
- effect labels: every built-in and internal tool has an explicit `effect`.

Portal (vitest + testing-library):
- Shell: consent screen renders effects and connection state, approve mounts
  the iframe, port handshake, bridge round-trip for `call` with a mocked API,
  destructive confirm allow / deny, a Space-supplied `confirmed` ignored,
  NOT_CONNECTED banner, CONSENT_REQUIRED returns to consent, navigated-away
  handling.
- Gallery: list, empty state.

## Docs

- `docs/site/_content/integrations/spaces.md` (reference) and
  `docs/site/_content/guides/spaces.md` (how to write one), nav entries.
- Note `effect` in the plugin SDK docs.
