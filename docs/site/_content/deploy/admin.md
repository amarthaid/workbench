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

> [!WARNING] The allowlist is a trust boundary
> Admin pages added later show every user's tool-call metadata and manage other
> users. List only people you would trust with that.
