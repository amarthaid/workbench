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

Five read-only cards, each loaded independently:

- **Instance:** version, database backend, cluster mode, audit-log destination, user and admin counts (the admin count is a number, never the list).
- **Activity:** every user's tool calls, newest first, with the user's email. Filter by app, errors only, or a user's email. Shows tool names and error text, never arguments. With `AUDIT_LOG_DEST` other than `sqlite` the events are not in the database, and the card says so.
- **Connections:** connected users per integration. "Needs reconnect" counts connections whose access token has expired and which have no refresh token; the server does not record refresh failures, so a connection that merely failed to refresh is not counted.
- **Custom apps:** every user's custom apps with owner and URL. Credentials are never shown.
- **Browser profiles:** disk used per user and whether the profile is live. Under `CLUSTER_ENABLED` each worker sees only its own volume, so the card lists that worker's profiles only.

> [!WARNING] The allowlist is a trust boundary
> The Overview shows every user's tool-call metadata (app, tool, error text, never
> arguments) and which users have which integrations connected. List only people
> you would trust with that.
