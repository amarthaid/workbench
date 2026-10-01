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

The instance summary sits at the top. Below it, **Activity**, **Connections**, **Custom apps** and **Browser profiles** are tabs; each loads only when you open it, so nothing walks the profiles on disk until you ask. They are read-only and fail independently:

- **Instance:** version, database backend, cluster mode, audit-log destination, user count and the number of allowlisted admins (a number, never the list; it counts allowlist entries, whether or not they have signed in).
- **Activity:** every user's tool calls, newest first, with the user's email. Filter by app, errors only, or a user's email. An unrecognised `status` filter is refused with a 400 rather than ignored. Shows tool names and error text, never arguments. With `AUDIT_LOG_DEST` other than `sqlite` the events are not in the database, and the card says so.
- **Connections:** connected users per integration. "Needs reconnect" counts connections whose access token has expired and which have no refresh token; the server does not record refresh failures, so a connection that merely failed to refresh is not counted.
- **Custom apps:** every user's custom apps with owner and URL. Credentials are never shown.
- **Browser profiles:** disk used per user and whether the profile is live. "Live" means a use-marker file moved in the last hour. Workers and pods that share a profiles volume all show up here.

## Managing users

The **Users** tab lists every user with their connection and custom-app counts, last activity, whether they have an API key, and whether they are disabled. The search box filters by email as you type (case-insensitive, matching anywhere in the address). The list is capped at 500 users, and search covers only those; the tab says so when the list was cut off.

- **Disable** signs the user out of the portal and stops every credential: their API key, OAuth logins and refresh tokens, and new SSO sign-ins. Their connections, vault and files are kept, so **Enable** restores the account. Disabling asks for confirmation.
- **Revoke key** clears the user's API key; agents using it stop working until they create a new one.
- You cannot disable yourself or any email on `ADMIN_EMAILS`. Admins are managed by that variable, not here, and this also stops an admin locking everyone out.
- Every action is written to the audit log with your account as the actor.

## Instance config

The **Config** tab holds two instance-wide settings:

- **Integrations:** turn an integration off for every user. It disappears from tool search, schema lookup and execution, the REST endpoint and the connect flow. Existing connections are kept, and turning it back on restores everything.
- **Custom apps:** choose who can add custom apps: everyone, no one, or selected users. Excluded users keep their existing apps, but agents stop seeing those apps' tools.

Changes apply at once in the process that handled the request. Other workers and pods pick them up within `INSTANCE_SETTINGS_POLL_SECONDS` (default 5), so allow that long before assuming a change is everywhere. OAuth client secrets are not editable here; they stay in environment variables.

> [!WARNING] The allowlist is a trust boundary
> The Overview shows every user's tool-call metadata (app, tool, error text, never
> arguments) and which users have which integrations connected, and the other tabs
> disable accounts and turn integrations off for everyone. List only people you
> would trust with that.
