---
title: Spaces
description: Built-in live apps. Deploy a web page at /s/<name> that calls integrations as whoever opens it, shared privately, org-wide or with a list of people.
---

A Space is a web page an agent builds that stays live. Where a [jot](jots.md) is a snapshot of data baked in at deploy time, a Space fetches and acts when someone opens it, through that person's own connections. Share a "my open PRs" timeline with a teammate and they see *their* PRs.

Like `jots`, it is an internal plugin: server source rather than `PLUGINS_DIR`, `auth: { type: "none" }`, always connected. The name `spaces` is reserved at load time.

## At a glance

| | |
|---|---|
| Plugin id | `spaces` |
| Auth | None (internal, always connected) |
| Tools | 5 |
| Opened at | `${PORTAL_URL}/s/<name>` (the portal shell) |
| Files served at | `${SERVER_PUBLIC_URL}/s/<name>/app/<sig>/` |
| SDK | `${SERVER_PUBLIC_URL}/s/_sdk/workbench.js` |

## Tools

| Tool | Effect | Purpose |
|---|---|---|
| `deploy_space` | write | Create or replace a Space. Saves its metadata, returns an upload URL and a single-use token |
| `update_space` | write | Change title, description, tools, visibility or users at once; with `files: true` or `delete`, also mint a patch upload |
| `list_spaces` | read | List your Spaces. Admins can pass `all: true` to list every Space with its owner |
| `list_space_files` | read | List the files of a Space you own |
| `delete_space` | destructive | Delete a Space, its shares, approvals, stored values and files. Owner or admin |

`deploy_space` takes `{ name, title, description?, tools, visibility, users? }`:

- `name` follows the [jot rules](jots.md#names-ownership-and-access) (lowercase letters, digits and hyphens, at most 64) and may not be `_sdk` or `upload`. Names are global and creator-locked: another user's name returns `SPACE_NAME_TAKEN`.
- `tools` is the list of fully-qualified registry tool names the page may call, such as `github_list_prs`. A tool from an internal plugin (`browser`, `jots`, `files`, `vault`, `spaces`), a custom-app tool or an unknown name returns `TOOL_NOT_ALLOWED`. The check is on the tool's integration, not on its name.
- `visibility` is `private` (only you), `org` (any signed-in user of this deployment) or `users` (the emails in `users`, required in that case, compared case-insensitively).

The metadata is saved at once. A new Space is not visible to anyone until its first upload lands.

## Upload

Uploads work exactly like [jot uploads](jots.md#deploy-upload-serve), with the same limits (`JOTS_MAX_BYTES`, `JOTS_MAX_FILES`, `JOTS_UPLOAD_TTL_SECONDS`) and error codes:

```bash
tar czf - -C <dir> . | curl --data-binary @- \
  -H 'Content-Type: application/gzip' <uploadUrl>
```

The archive root must contain `index.html` (`NO_INDEX` otherwise). `update_space` with `files: true` mints a **patch** token: the archive is overlaid onto the live files after the `delete` paths are removed, and the merged tree is measured again. Tokens are rows in `pending_auth` under the `__space_upload__` sentinel, single use, and survive a restart.

Files live under `SPACES_DIR` (default: `spaces/` next to the SQLite file).

> [!WARNING] Several replicas need a shared `SPACES_DIR`
> Space metadata is in the database, but the files are on disk, and a Space is only served once its `index.html` exists there. With PostgreSQL and more than one replica, mount `SPACES_DIR` on a volume every replica shares (the same as `JOTS_DIR`). Otherwise a Space uploaded through one replica answers 404 on the others.

The call rate limit (60 calls a minute per viewer per Space, shared with the KV routes) is counted in each process, so under `CLUSTER_ENABLED` or several replicas the effective limit is that number per process.

## Who can open a Space

The owner always can. With `org`, any signed-in user can. With `users`, a viewer whose email is on the list can. Admins can list and delete every Space but cannot open one that was not shared with them: opening a Space runs its code as the viewer, which is not an admin power. Every portal endpoint answers 404 when the viewer cannot open the Space, so names cannot be probed.

## Running a Space

A viewer opens `/s/<name>` in the portal. The portal shell:

1. Shows a consent screen listing every declared tool, grouped by integration and tagged Reads, Writes or Asks first. Approval is recorded for the current tool list; when the author changes the list, every viewer is asked again.
2. Loads the author's files in an iframe with `sandbox="allow-scripts allow-forms"`.
3. Answers the page's SDK requests over a `MessageChannel`, and asks the viewer to confirm every `destructive` call. The author cannot turn that confirmation off.

The page never holds a credential. Calls run on the server as the viewer, with the viewer's connections, and are audited with `client_name = "space:<name>"`, so the Activity page shows which Space made each call.

### Tool effects

Each tool declares `effect: "read" | "write" | "destructive"`. An unlabelled tool counts as `destructive`. `search_tools` and `get_tool_schema` show the label, so an author can see which calls will prompt the viewer.

## Serving and isolation

Author files are served from `/s/<name>/app/<sig>/`. The sandboxed iframe sends no cookie or token, so the `sig` path segment carries access: an HMAC over the Space name, the viewer and an expiry about 12 hours out, minted when the viewer opens the Space. A bad or expired `sig` is a 404. Every response carries:

```
Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none';
  script-src 'self' <origins> 'unsafe-inline' 'unsafe-eval';
  style-src 'self' <origins> 'unsafe-inline';
  img-src 'self' <origins> data: blob:; font-src 'self' <origins> data:;
  media-src 'self' <origins> data: blob:; connect-src 'none';
  form-action 'none'; frame-src 'none'; base-uri 'none';
  frame-ancestors <origins>
X-Content-Type-Options: nosniff
Cross-Origin-Resource-Policy: cross-origin
Referrer-Policy: no-referrer
Cache-Control: private, no-store
```

`<origins>` is the origin of `SERVER_PUBLIC_URL` plus the origin of `PORTAL_URL` when it differs (the portal frames the page, and in dev or a split deployment the files and SDK are fetched through it). No remote host is allowed anywhere and `connect-src` is `'none'`, so a Space cannot `fetch` anything: its data comes through the SDK only, and every asset must be bundled or inlined.

> [!WARNING] Exfiltration-resistant, not exfiltration-proof
> A sandboxed frame can still navigate itself to an outside URL and put data in it. The shell stops a Space that navigates (and a navigated document never gets the bridge port), but whatever was in the URL has left. DNS prefetch is not governed by CSP either. Mitigations: authors are signed-in members, consent lists every tool, every call is audited, and admins can delete any Space.

## Portal API

Used by the portal shell. Portal session JWT only (`Authorization: Bearer`); API keys and OAuth tokens get 401, and disabled users are refused.

| Method and path | Purpose |
|---|---|
| `GET /api/spaces` | Spaces the viewer can open, newest first |
| `GET /api/spaces/:name` | Metadata, tools with `effect` and `connected`, `consented`, `appUrl` |
| `POST`, `DELETE /api/spaces/:name/consent` | Approve or revoke the current tool list |
| `POST /api/spaces/:name/call` | Run a declared tool as the viewer |
| `GET /api/spaces/:name/kv`, `GET`, `PUT`, `DELETE /api/spaces/:name/kv/:key` | Per-viewer key-value store |

`POST /call` checks, in this order: access (404), consent for the current tool list (403 `CONSENT_REQUIRED`), the tool is declared (403 `TOOL_NOT_DECLARED`), it still exists (404 `TOOL_UNAVAILABLE`), a `destructive` tool carries `confirmed: true` (428 `CONFIRMATION_REQUIRED`), no `{{vault:` anywhere in the arguments (400 `INVALID_ARGS`), and the rate limit of 60 calls per minute per viewer and Space (429 `RATE_LIMITED` with `retryAfterMs`). Then it runs the tool. A missing connection is 409 `NOT_CONNECTED`, rejected arguments 400 `INVALID_ARGS`, anything else 502 `UPSTREAM_ERROR`.

Vault references are never resolved for a Space. Otherwise a page could put `{{vault:prod_token}}` in a comment body and ship the viewer's secret upstream.

The key-value store holds JSON values of at most 64 KiB each and 256 KiB per viewer per Space (413 `TOO_LARGE`). Keys are 1 to 128 characters. A key that is not set is 404 `KEY_NOT_FOUND`, distinct from the Space-level 404 `NOT_FOUND`. Store requests count against the same 60-per-minute bucket as `/call`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SPACES_DIR` | `spaces/` next to the SQLite file | Where Space files live |
| `JOTS_MAX_BYTES`, `JOTS_MAX_FILES`, `JOTS_UPLOAD_TTL_SECONDS` | see [Jots](jots.md#limits) | Upload limits, shared with jots |

See [Building a Space](../guides/spaces.md) for a worked example.
