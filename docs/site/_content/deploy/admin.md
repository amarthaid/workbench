---
title: Admin page
description: Naming admins with ADMIN_EMAILS, what the gate accepts, and what an admin can see.
---

The portal has an **Admin** item in the sidebar, shown only to admins. It is the
same portal, not a separate app.

## Naming admins

Set `ADMIN_EMAILS` to a comma-separated list and restart:

```bash
ADMIN_EMAILS=admin@example.com,ops@example.com
```

Matching is case-insensitive and ignores surrounding spaces. Empty, the default,
means nobody is admin. There is no in-app promote or demote: the env var is the
only source, so access is revoked by removing the email and restarting.

## What the gate accepts

`/api/admin/*` accepts the **portal session only**. An API key, including an
admin's own MCP key, gets `401`, so an agent never acts as admin. A signed-in
user who is not on the list gets `403`.

The email is read from the stored user record, not from the session token, and
both SSO providers reject an unverified email, so an unverified address cannot
reach the allowlist.

## What the Overview shows

Every section is its own tab with its own URL (`/admin`, `/admin/activity`, `/admin/connections`, `/admin/custom-apps`, `/admin/profiles`, `/admin/vault`, `/admin/files`, `/admin/spaces`, `/admin/users`, `/admin/config`), so the browser's back button moves between them. Each tab loads only when you open it, so nothing walks the profiles or the workspace on disk until you ask. They are read-only and fail independently.

The **Overview** tab holds:

- **Headline numbers:** tool calls and error rate over the last 24 hours (with the change against the 24 hours before), users active in the last 7 days, connections that need a reconnect, and disabled users. Usage figures need the database among the audit destinations (`AUDIT_LOG_DEST` default `db`, or `db,kafka`); with `stdout` alone they show a dash and say why, while the user and connection counts still show.
- **Top tools:** the most-called tools over 7 days with error counts and average time.
- **Recent failures:** the last five failed calls, with the error text, linking to Activity.
- **Instance:** version, database backend, cluster mode, audit-log destination, user count and the number of allowlisted admins (a number, never the list; it counts allowlist entries, whether or not they have signed in).
- **Activity:** every user's tool calls, newest first, with the user's email. Filter by app, errors only, or a user's email. An unrecognised `status` filter is refused with a 400 rather than ignored. Shows tool names and error text, never arguments. It also shows `curl_session` mints (`CURL_SESSION`) and proxied curl requests (`CURL_REQUEST`, method and path only). With `AUDIT_LOG_DEST=stdout` alone the events are not in the database, and the card says so; a Kafka copy does not change this. Under each email: how the call authenticated (API key, OAuth with the client's name, Portal, Curl token) and the source IP; hover for the user agent. With `AUDIT_PAYLOAD` on, a call with captured arguments or result has a **Details** button showing them (pretty-printed, or marked truncated with the full size); every open is itself recorded in the audit log.
- **Connections:** connected users per integration. "Needs reconnect" counts connections whose access token has expired and which have no refresh token; the server does not record refresh failures, so a connection that merely failed to refresh is not counted.
- **Custom apps:** every user's custom apps with owner and URL. Credentials are never shown.
- **Browser profiles:** disk used per user and whether the profile is live. "Live" means a use-marker file moved in the last hour. Workers and pods that share a profiles volume all show up here.
- **Vault:** counts only. Secrets stored, users holding any, secrets unused for 90 days, pending one-time links, and the users holding the most. No secret name or value is ever returned.
- **Files:** the agent file workspace. Disk used, file count, the age of the oldest file (older than `WORKSPACE_TTL_HOURS` means the reaper is not running), and the largest users and files by size. No file name or content is ever returned.

- **Spaces:** every Space, newest updated first, as a card with title and name, owner email, audience (Only me, Specific people with the count, or Everyone signed in), last updated, the description clamped to two lines, the like count and how many people opened it in the last 30 days. Expanding a card lists who opened it and when they last did (the owner's own opens are excluded). The list is paged and has a search box (name prefix or title). It is read only: no delete, edit or open from here. Each opener list is capped at 50 people per Space; the count stays the true number.

## Managing users

The **Users** tab lists every user with their connection and custom-app counts, last activity, whether they have an API key, and whether they are disabled. The search box filters by email as you type (case-insensitive, matching anywhere in the address). The list is capped at 500 users, and search covers only those; the tab says so when the list was cut off.

- **Disable** signs the user out of the portal and stops every credential: their API key, OAuth logins and refresh tokens, and new SSO sign-ins. Their connections, vault and files are kept, so **Enable** restores the account. Disabling asks for confirmation.
- **Revoke key** clears the user's API key; agents using it stop working until they create a new one.
- You cannot disable yourself or any email on `ADMIN_EMAILS`. Admins are managed by that variable, not here, and this also stops an admin locking everyone out.
- Every action is written to the audit log with your account as the actor.

### Per-user permissions

**Permissions** on a user's row opens their per-user permissions. Each capability shows its default and offers two choices: the opposite of the default (**Allow** for a capability that is off by default) or **Default**. When an admin set it, the row says who and when ("Granted by admin@example.com, 26 Nov").

| Capability | Default | What it allows |
|---|---|---|
| Add and use custom apps | off | The user can connect their own MCP servers as custom apps. A user without it cannot add or update custom apps, and agents stop seeing the tools of any custom apps they already have (the apps themselves are kept) |
| Delegate access in Spaces | off | The user can turn on [delegated access](../integrations/spaces.md#delegated-access) for their shared Spaces, so viewers run its tools with this user's connections |

Users created after this permission shipped start without **Add and use custom apps**; an admin allows it per user. On first start after the upgrade, the old Config setting "Who can add custom apps" is converted once: with everyone allowed (also the old default, when it was never set), every existing user is granted the permission; with selected users, each listed user that still exists; with no one, nobody. Those rows show as granted by `system`. A `custom_apps_policy_migrated` marker in `instance_settings` stops it running again, and the old setting is then ignored.

Setting **Delegate access in Spaces** back to Default while the user has Spaces using it asks first ("dev@example.com has 2 Spaces using delegated access. They will stop working for viewers until it is allowed again."). Their Spaces keep the setting: viewers get **Shared access is off**, and allowing it again resumes them. The permission is read on every call, so a change applies at once.

The same, over the admin API (portal session of an admin only, like every `/api/admin/*` route):

| Method and path | Purpose |
|---|---|
| `GET /api/admin/users/:id/permissions` | `{ permissions: [{ capability, label, description, default, effect, source, grantedBy, grantedByEmail, grantedAt }], delegatedSpaces }`; `source` is `rule` or `default`, `grantedAt` Unix seconds |
| `PUT /api/admin/users/:id/permissions/:capability` | Body `{ effect }`. Only the opposite of the default is accepted (400 `invalid_effect` otherwise) |
| `DELETE /api/admin/users/:id/permissions/:capability` | Back to the default |

An unknown capability is 400 `unknown_capability`, an unknown user 404 `user_not_found`. Each change is audited as `ADMIN_PERMISSION_SET` or `ADMIN_PERMISSION_CLEAR` with your account as the actor.

## Approving new accounts

By default anyone who can sign in gets an account at once. Set
`REQUIRE_SIGNUP_APPROVAL=true` (and restart) to hold new accounts instead: a
first-time sign-in creates the account as **pending**, and the person sees
"waiting for an admin to approve" on the login page. A pending account cannot use
the portal, an API key, an agent connection or any OAuth grant.

Pending accounts appear under **Admin, Approvals** with a count. **Approve**
activates the account; **Reject** keeps it blocked and can carry a note. A
rejected person can ask again 24 hours after their last request. **Disable** on
the Users tab is the permanent no. Approving from the Users tab (the **Approve**
button on a pending row) does the same thing.

Admins (anyone on `ADMIN_EMAILS`) are never held, so there is always someone who
can approve. Turning the setting on does not change existing accounts.

## Instance config

The **Config** tab holds two instance-wide settings:

- **Integrations:** turn an integration off for every user. It disappears from tool search, schema lookup and execution, the REST endpoint and the connect flow. Existing connections are kept, and turning it back on restores everything.
- **Browser blocked domains:** domains that agent browser tabs may not load, one per line. A plain entry also blocks its subdomains; a `*.example.com` entry blocks only the subdomains, not `example.com` itself. A second list holds **exceptions**: hosts to allow even though a block entry matches. The more specific entry wins and an exception wins a tie, so block `*.prod.example.com` plus exception `x.prod.example.com` allows only `x.prod.example.com` (and its subdomains) among the prod hosts. Entries in both lists are normalised (lowercased, a trailing dot dropped, a pasted URL reduced to its host, international names to punycode), and an entry that is not a hostname or IP rejects the save and is named in the error. Every HTTP(S) request is checked, not just navigations; WebSocket connections are not. See [Browser](../integrations/browser.md).

Changes apply at once in the process that handled the request. Other workers and pods pick them up within `INSTANCE_SETTINGS_POLL_SECONDS` (default 5), so allow that long before assuming a change is everywhere. OAuth client secrets are not editable here; they stay in environment variables.

> [!WARNING] The allowlist is a trust boundary
> The Overview shows every user's tool-call metadata (app, tool, error text, never
> arguments) and which users have which integrations connected, and the other tabs
> disable accounts and turn integrations off for everyone. List only people you
> would trust with that.
