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
| `update_space` | write | Change title, description, tools, visibility or the share list at once (`add_users` / `remove_users` edit it, `users` replaces it); with `files: true` or `delete`, also mint a patch upload. `delegate_access: false` turns [delegated access](#delegated-access) off |
| `list_spaces` | read | List your Spaces, with `delegate_access`, `delegation_active` and `delegation_suspended`. Admins can pass `all: true` to list every Space with its owner |
| `list_space_files` | read | List the files of a Space you own |
| `delete_space` | destructive | Delete a Space, its shares, approvals, stored values and files. Owner or admin |

`deploy_space` takes `{ name, title, description?, tools, visibility, users? }`:

- `name` follows the [jot rules](jots.md#names-ownership-and-access) (lowercase letters, digits and hyphens, at most 64) and may not be `_sdk` or `upload`. Names are global and creator-locked: another user's name returns `SPACE_NAME_TAKEN`.
- `tools` is the list of fully-qualified registry tool names the page may call, such as `github_list_prs`. A tool from an internal plugin (`browser`, `jots`, `files`, `vault`, `spaces`), a custom-app tool or an unknown name returns `TOOL_NOT_ALLOWED`. The check is on the tool's integration, not on its name.
- `visibility` is `private` (only you), `org` (any signed-in user of this deployment) or `users` (the emails in `users`, required in that case, compared case-insensitively).
- The share list: `users` on `deploy_space` or `update_space` **replaces** it, so anyone left out loses access, and redeploying without `users` clears it. To grant or revoke one person, use `update_space` with `add_users` / `remove_users`, which leave everyone else on the list; they cannot be combined with `users` (`CONFLICTING_USERS`). Removing the last person from a `users` Space is refused (`USERS_REQUIRED`). `list_spaces` returns the current list as `users`.

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

## Asking for access

A Space shared with specific people answers 404 to everyone else, so a
person who follows its link sees only the Space name, with no mention of whether
it exists. They can press **Ask the owner for access**. The portal answers the same way whether or not the Space
exists, is private or open to everyone, so the button cannot be used to find
Spaces. If the Space is shared with specific people and has files, the owner
gets a request (a short message from the requester, plain text) under **Requests**
in the gallery and in the Sharing dialog. **Approve** adds the requester's email
to the share list, exactly like adding them by hand; **Reject** keeps it as it
was. If the Space runs with the owner's access ([delegated access](#delegated-access)),
the Approve row says so, because approving lends those connections. Only the
owner decides; admins have no path. A requester can send at most three requests
per Space a day, twenty a day in total, and have five open at a time.

## Running a Space

A viewer opens `/s/<name>` in the portal. The portal shell:

1. Shows a consent screen listing every declared tool, grouped by integration and tagged Reads, Writes or Deletes or changes, with an **Always allow | Ask first** control on every tool that is not a read (a read-only badge for a delegated viewer). Approve stays disabled until the viewer has connected every integration the Space uses; an unconnected one shows a Connect button that opens that integration's page in a new tab, and the screen re-checks when the viewer returns. Approval is recorded for the current tool list; when the author changes the list, every viewer is asked again.
2. Loads the author's files in an iframe with `sandbox="allow-scripts allow-forms"`.
3. Answers the page's SDK requests over a `MessageChannel`, and asks the viewer to confirm every call whose tool is set to **Ask first** (see [Tool approvals](#tool-approvals)). The author cannot turn that confirmation off.

The page never holds a credential. Calls run on the server as the viewer, with the viewer's connections (or the owner's, with [delegated access](#delegated-access)), and are audited with `client_name = "space:<name>"`, so the Activity page shows which Space made each call.

### Tool effects

Each tool declares `effect: "read" | "write" | "destructive"`. An unlabelled tool counts as `destructive`. `search_tools` and `get_tool_schema` show the label, so an author can see which calls will prompt the viewer by default; viewers can change that per tool (see [Tool approvals](#tool-approvals)).

## Tool approvals

Each non-read tool in a Space has an approval mode: `auto` (shown as **Always allow**) or `ask` (**Ask first**). Read tools have none and never ask. With no saved choice a `write` tool is `auto` and a `destructive` or unlabelled tool is `ask`. A tool the server cannot find, or an internal one, is always `ask` and cannot be changed.

- **Who sets it.** In an ordinary Space each viewer sets their own modes, including the owner. In a Space with stored access mode `owner` (see [Delegated access](#delegated-access)), the owner's modes are the policy for every viewer and viewers cannot set their own. This follows the stored mode, so it also holds while delegation is paused or blocked: calls are refused with `DELEGATION_OFF`, but a viewer still cannot change a mode. Only turning delegation off (stored mode back to `viewer`) gives viewers their own modes again.
- **Portal only.** The route needs a portal session. MCP tokens and API keys get 401, `deploy_space` and `update_space` take no approval parameter and never write, reset or delete modes, and the bridge has no approval message: a Space page can only send `call`.
- **Storage.** A row exists only when the choice differs from the tool's default, per Space, person and tool name. Setting a tool back to its default deletes the row. Rows survive a tool leaving the list and coming back, and are deleted with the Space.
- **Enforcement.** On every call the server computes the effective mode. A tool in `ask` mode needs `confirmed: true` in the call body, which only the shell sets after the person confirms. Without it the answer is 428 `CONFIRMATION_REQUIRED`, for writes as well as destructive tools, and a delegated refusal is audited as before. A destructive tool set to Always allow runs without `confirmed`. Calls that run without asking are still rate limited (60 per minute per viewer and Space) and audited.
- **Page swaps.** A redeploy that changes only the page files does not change the tool list, so most people are not asked again. Someone is **elevated** when a tool whose default is Ask first (a destructive or unclassified tool) is set to Always allow for them, by choice or through Allow all (in a delegated Space, by the owner's settings). An elevated person approves again whenever the Space itself changes: their consent records the Space's `updated_at`, which moves on a page upload and on a tool list change but not on a metadata edit, and a different value is a re-consent with `reconsent_reason: "page"`. A person who only allows write tools is not asked again, and neither is anyone who changes their own modes in View tools while approved.

### Re-approval when the owner loosens (delegated Spaces)

A delegated viewer's consent records which tools ran without asking on the screen they approved (the auto set, delegable non-read tools in `auto` mode). The detail's `consent_hash` for that viewer also covers the auto set, so a setting that changes between loading the screen and clicking Approve is 409 `CONSENT_CHANGED`. After approval:

- The owner **tightens** a tool: the current auto set is a subset of the approved one, so the change takes effect with no new approval.
- The owner **loosens** a tool, or a plugin update reclassifies a tool so that it now runs without asking: the current set has a tool the viewer never saw as silent, so the next call is 403 `CONSENT_REQUIRED` and the portal shows the consent screen again with `reconsent_reason: "approvals"`. A change to the tool list, mode or owner gives `reconsent_reason: "tools"`.
- Consents given before this existed are treated as having approved the Space's `write` tools that can be delegated, and are filled in with those names at startup after plugins load.
- The viewer cannot widen their approved set while delegation is paused, because the check is against the saved set, not the current screen.

For an ordinary Space and for the owner this check is skipped: their modes are their own, and `consent_hash` is the plain one.

## Delegated access

By default a Space runs every call with the viewer's own connections. An owner can instead switch a shared Space to **Delegate my access**: every viewer's calls then run with the owner's connections. Use it for a Space that shows data the viewers cannot reach themselves, such as a team dashboard over the owner's project tracker.

### What it lends

Everything the Space declares, with any input. A viewer holds a portal session and can call `POST /api/spaces/:name/call` directly, so the page's own code and its confirmation dialog do not limit what they send: arguments are free, and `confirmed` is a body field. The owner is shown every declared tool, reads included, before turning it on.

What it does not lend:

- **Vault secrets.** Vault references are refused for every Space call, delegated or not. If a result happens to contain a value the owner recently used from their vault, the viewer sees `[redacted]` in its place, never the value or the secret's name.
- **Tools marked `delegable: false`.** A tool that changes its own connection state (for example one that rewrites its stored credential) never runs with someone else's access: 403 `TOOL_NOT_DELEGABLE`. The owner's tool list marks them **Owner only**.
- **Cookie auto-reconnect.** It would type the owner's stored login into the owner's browser on a viewer's behalf, so it is skipped. A delegated call on a dead cookie session answers "the owner needs to reconnect" instead.

### Who can turn it on

1. An admin allows the user: **Admin > Users > Permissions > Delegate access in Spaces > Allow** (see [Per-user permissions](../deploy/admin.md#per-user-permissions)). Without it the switch is hidden.
2. The owner turns it on in the portal only: open the Space, **Menu > Sharing**, **Delegate my access**. The dialog lists every declared tool and asks a second time (**Delegate your access?**). Widening the audience while it is on (specific people to everyone signed in) asks again the same way.
3. The Space must be shared (`org` or `users`). Setting it to **Only me**, by any path, turns delegation off.

An agent cannot turn it on: `deploy_space` and `update_space` refuse `delegate_access: true` with `DELEGATION_PORTAL_ONLY`, so a prompt-injected owner agent cannot lend the owner's access. Nor can it lend it to more people: while delegation is on, widening who can open the Space (specific people to everyone signed in, or adding anyone to the share list through `add_users`, a `users` replace or a redeploy) is refused with the same code. Narrowing (removing people, everyone signed in to specific people, only me) is allowed, and so is `delegate_access: false`, also in the same call as a widening.

### Pinned to the reviewed tool list

Turning it on records the hash of the tool list the owner saw (the portal sends it back as `tools_hash`; a stale one is 409 `TOOLS_CHANGED`). When the tool list changes afterwards, delegation **pauses**: viewers get `DELEGATION_OFF` with reason `tools_changed`, and the owner sees **The tool list changed. Review and confirm to resume.** in the Sharing dialog. A redeploy that restores the confirmed list resumes it. `deploy_space` and `update_space` answer `delegation_suspended: true` when their change paused it.

### Consent

A viewer's approval covers the tool list, the access mode and the owner. Turning delegation on or off asks every viewer to approve again, and the consent screen says **These tools run with <owner>'s access, not yours.** It lists the tools and what they do, but no connection state: the viewer's own connections are never checked or used. The owner is never re-asked for a mode change (their own calls always run as themselves), only for a tool list change.

While delegation is in effect, the owner must have connected every integration the Space uses. Until they have, a viewer cannot enter the Space at all, approved or not: they see a full-page **Waiting for the owner** card with "<owner> needs to reconnect <apps> before this Space can be used." and a **Try again** button. This tells viewers which integrations the owner lacks (they need it to know why they are held), never the owner's permission or account state. The owner opening their own delegated Space is not held by this: they get the ordinary connect-before-approve screen for their own connections.

### While it runs

- The viewer's top bar reads **Using <owner>'s delegated access**, and a call to a tool set to Ask first asks **Run <tool> as <owner>?**.
- Every call is one audit row owned by both people, and so is every refusal (delegation off, owner not connected, not delegable, confirmation needed, bad arguments), except rate limiting: `user_id` is whose access ran (the owner) and the actor is who triggered it (the viewer). Both see it in their own Activity page, tagged **Delegated**: "qa@example.com used your access via Sprint Board" for the owner, "You used dev@example.com's access via Sprint Board" for the viewer. Admin counts are not doubled.
- Failures never fall back to the viewer's own access. When the owner's permission is removed, the owner is disabled or gone, or the Space is private, calls answer 403 `DELEGATION_OFF` (reason `turned_off`) and the viewer sees **Shared access is off**. When the owner is missing a connection for any integration the Space uses, every call answers 409 `OWNER_NOT_CONNECTED` (reason `owner_not_connected`) before anything runs, and the viewer sees **Waiting for the owner**. When the owner's connection turns out to be dead only during the call (an expired grant), it answers 409 `NOT_CONNECTED` with `delegated: true` and "<owner> needs to reconnect <app>.", with no connect action for the viewer.
- Besides each viewer's 60 calls per minute, all viewers together share 300 calls per minute per Space against the owner's connections, so many viewers cannot exhaust the owner's upstream quota. Like the viewer limit, it is counted in each process.
- The owner opening their own Space always runs as themselves.

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

## The gallery

The portal's **Spaces** page orders itself around the person looking at it, because Spaces matter unequally to different people.

- **Favorites** come first, as large tiles. The heart on a tile marks or unmarks it. More than six favorites still show, but the extra ones as compact tiles, so a long list does not push everything else off screen.
- **Recently opened** is the last four Spaces you opened that are not favorites.
- **All Spaces** is the rest, most recently updated first. A Space someone else shared that was updated in the last 14 days and that you have never opened carries **New**.
- Search matches the title, description, owner and name. **Mine** and **Shared with me** narrow the list.

Order never depends on how popular a Space is. A popularity order would put Spaces open to everyone at the top for everybody, and would keep whatever is already on top there. Each tile gets a generated cover from the Space's name (not its title, so a rename does not change it) rather than a screenshot, because a screenshot would show one viewer's private data to everyone else.

**What is counted.** The number next to the heart is how many people have favorited the Space, among people who can still open it: someone removed from the share list stops counting, and counts again if they are added back. It is not shown for a private Space or when it is zero, and never says who. An open is recorded when the portal shell mounts the Space for someone who has approved its tools, once per person however often they reload, and what is kept per person is only when they last opened it. The owner, and only the owner, sees **N people this month** on the tile: people other than the owner who opened it in the last 30 days. It is shown for a Space open to everyone signed in, and for a shared one only from five people up, because a smaller number on a short share list would say who.

**Editing from the gallery.** The owner's tile has a menu: **Edit details** changes the title and description, and **Sharing** opens the same dialog as inside the Space, both without opening it. The audience badge on your own tile (**Private**, **Shared**, **Everyone signed in**) is a shortcut to the same Sharing dialog. The tool list stays with the agent: changing it asks every viewer to approve again.

## Portal API

Used by the portal shell. Portal session JWT only (`Authorization: Bearer`); API keys and OAuth tokens get 401, and disabled users are refused.

| Method and path | Purpose |
|---|---|
| `GET /api/spaces` | Spaces the viewer can open, with `delegate_access` and `delegation_suspended`, and the viewer's own `favorited` and `last_opened_at`, the people-count `favorite_count`, and for the owner `viewers_30d` (see [The gallery](#the-gallery)) |
| `GET /api/spaces/:name` | Metadata, tools with `effect`, `connected`, `delegable`, `approval` (`"auto"` or `"ask"`, absent for read tools) and `approvalEditable`, `consented`, `reconsent_reason` (`"tools"`, `"approvals"` or `"page"`, only when the viewer had approved before and no longer satisfies consent), `consent_hash`, `appUrl`, `delegate_access`, `delegation_suspended`, `delegation_off`; the owner also gets `tools_hash` and `can_delegate`. For a viewer of a delegated Space whose owner is missing a connection, `delegation_off` is `{ reason: "owner_not_connected", message }` |
| `PATCH /api/spaces/:name` | Owner only: change `title` and `description` (`{ title?, description? }`; an empty description clears it; 120 and 1000 characters at most). It does not change the tool list, so nobody is asked to approve again, and it does not count as the Space being updated. An agent's next `deploy_space` sets both again |
| `PUT`, `DELETE /api/spaces/:name/favorite` | Mark or unmark the Space as the viewer's favorite; answers `{ favorited, favorite_count }`. Anyone who can open the Space may |
| `POST /api/spaces/:name/open` | The shell reports that it mounted the Space. Recorded only for a viewer who has approved the tool list; answers `{ recorded }` |
| `PATCH /api/spaces/:name/sharing` | Owner only: change `visibility`, add or remove people, and turn delegated access on or off (`{ visibility?, add_users?, remove_users?, delegate_access?, tools_hash? }`), same rules as `update_space`; answers `{ visibility, users, delegate_access, delegation_suspended }` |
| `POST`, `DELETE /api/spaces/:name/consent` | Approve (`{ consent_hash }` from the detail) or revoke. A missing hash, or a Space that changed since it was shown, is 409 `CONSENT_CHANGED`. Approving is refused with 409 `INTEGRATION_NOT_CONNECTED` while the viewer has not connected an integration the Space uses. For a viewer of a delegated Space the viewer's connections are not checked; instead it is refused with 409 `OWNER_NOT_CONNECTED` (`{ code, message }`) while the owner has not connected one |
| `PUT /api/spaces/:name/tool-approvals` | Set approval modes: `{ tools: { <tool>: "auto" \| "ask" } }`, one tool or all at once, in one transaction; answers `{ tools }` in the detail's shape. 400 `INVALID_APPROVAL` for a body that is not an object of `auto` or `ask`, a tool the Space did not declare, an unavailable tool, or a read tool; nothing is applied. 403 `APPROVAL_SET_BY_OWNER` for a viewer of a Space whose stored mode is `owner`, delegation in effect or not. No consent is needed, so the consent screen can save its choices just before approving |
| `POST /api/spaces/:name/call` | Run a declared tool as the viewer (or as the owner, when delegated); a viewer of a delegated Space whose owner is missing a connection gets 409 `OWNER_NOT_CONNECTED` for every tool |
| `GET /api/spaces/:name/kv`, `GET`, `PUT`, `DELETE /api/spaces/:name/kv/:key` | Per-viewer key-value store |

For the owner, `delegate_access` is the stored setting; for anyone else it is whether delegation is in effect. A viewer sees whether it is paused (the tool list changed) or off, never the owner's permission or account state: a revoked permission, a disabled owner and a private Space all read the same "turned off". `connected` reports the owner's connections when delegation is in effect. `delegation_off` is `{ reason: "turned_off" | "tools_changed" | "owner_not_connected", message }` or `null`; `owner_not_connected` is only ever shown to viewers other than the owner, while delegation is otherwise in effect (so `delegate_access` stays `true`). Turning delegation on needs `tools_hash` (400 `INVALID_ARGS` without it), the admin permission and a shared audience (403 `DELEGATION_NOT_ALLOWED`), and the current tool list (409 `TOOLS_CHANGED`); a concurrent change is 409 `CONFLICT`.

`approvalEditable` is false for read and unavailable tools and for viewers of a Space whose stored mode is `owner`; for those viewers `approval` shows the owner's mode. Tools the server cannot find carry `approval: "ask"`. When the owner changes approvals in a Space whose stored mode is `owner`, one audit row with action `SPACE_APPROVAL_CHANGE` is written per request, with `tool` set to `space:<name> approvals: <tool>=<mode>,...` listing only the changes that took effect (none if nothing changed). A failed audit write is logged and the change still succeeds.

`POST /call` checks, in this order: access (404), consent for the current tool list (403 `CONSENT_REQUIRED`), the tool is declared (403 `TOOL_NOT_DECLARED`), it still exists (404 `TOOL_UNAVAILABLE`), the rate limit of 60 calls per minute per viewer and Space (429 `RATE_LIMITED` with `retryAfterMs`), delegated access is in effect when the Space is delegated (403 `DELEGATION_OFF` with `reason`), the owner has connected every integration the Space uses when a viewer calls a delegated Space (409 `OWNER_NOT_CONNECTED`, reason `owner_not_connected`), the tool may run with someone else's access (403 `TOOL_NOT_DELEGABLE`), a tool whose approval mode is `ask` carries `confirmed: true` (428 `CONFIRMATION_REQUIRED`; a `destructive` or unlabelled tool unless the viewer set it to Always allow, a `write` tool only if set to Ask first), no `{{vault:` anywhere in the arguments (400 `INVALID_ARGS`), and, when delegated, the owner's limit of 300 calls per minute per Space (429 `RATE_LIMITED`). Then it runs the tool. The viewer's limit comes before the refusals that are audited, so a page looping on a refusal cannot flood the owner's audit log; a 429 is never audited. A missing connection is 409 `NOT_CONNECTED` (with `delegated: true` when it is the owner's), rejected arguments 400 `INVALID_ARGS`, anything else 502 `UPSTREAM_ERROR`.

Vault references are never resolved for a Space. Otherwise a page could put `{{vault:prod_token}}` in a comment body and ship the viewer's secret upstream.

The key-value store holds JSON values of at most 64 KiB each and 256 KiB per viewer per Space (413 `TOO_LARGE`). Keys are 1 to 128 characters. A key that is not set is 404 `KEY_NOT_FOUND`, distinct from the Space-level 404 `NOT_FOUND`. Store requests count against the same 60-per-minute bucket as `/call`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SPACES_DIR` | `spaces/` next to the SQLite file | Where Space files live |
| `JOTS_MAX_BYTES`, `JOTS_MAX_FILES`, `JOTS_UPLOAD_TTL_SECONDS` | see [Jots](jots.md#limits) | Upload limits, shared with jots |

See [Building a Space](../guides/spaces.md) for a worked example.
