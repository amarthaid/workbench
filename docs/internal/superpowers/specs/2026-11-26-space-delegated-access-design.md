# Space delegated access ("Delegate my access")

Status: approved design, revised after review, not yet implemented.

## Problem

A Space runs every tool call with the **viewer's** own connections. A viewer
who has not connected (or cannot connect) a tool the Space uses sees nothing
from it. Owners want to share a Space whose data comes from **their** access,
so people without that tool can still use it.

This lends one person's credentials to others, so it is admin-gated, enabled
only by a human in the portal, pinned to the tool list the owner confirmed,
and every call (and every refusal) is audited under both people.

## Summary

- Sharing keeps its three audiences: Only me, Specific people, Everyone signed
  in. A separate per-Space switch, **Delegate my access**, makes tool calls run
  with the owner's connections instead of the viewer's.
- Viewers always sign in. The switch only applies to Specific people and
  Everyone signed in.
- Only owners an admin has granted `spaces.delegate_access` can turn it on,
  and only from the portal. Agents can read it and turn it off.
- Delegation is pinned to the tool list confirmed at enable time. Any change to
  the list suspends it until the owner confirms again.
- Reads and writes follow the Space's declared tools. Destructive tools confirm
  every call. Viewers can call any declared tool with any input (see Threat
  model).
- One audit row per call names both the owner (whose access ran) and the
  viewer (who triggered it). Both see it in their Activity.

## Threat model (what the owner is lending)

- A viewer holds a portal session and can POST to `/api/spaces/:name/call`
  directly. The Space's page, and the destructive dialog, do not constrain
  them: `args` are free and `confirmed` is a body field. So delegation lends
  **every declared tool, with any input**. The enable warning says exactly
  that and lists every declared tool, reads included.
- Tools that change the owner's connection state (for example a tool that
  rewrites its own stored credential) are marked `delegable: false` and are
  refused in delegated mode.
- The owner's vault secrets are never passed to the page or the viewer
  (vault references are refused). Cookie auto-reconnect, which types the
  owner's stored login into the owner's browser, is **skipped** for delegated
  calls: the viewer gets "owner needs to reconnect" instead.
- The owner's own agent is not trusted to widen what is lent: it cannot enable
  delegation, and changing the tool list suspends it.

## 1. Permissions and the sharing setting

### Per-user permissions layer

A general per-user permission store. Delegation is its first capability; later
ones (block an integration for one user, stop a user creating Spaces) fit
without schema change.

Table `user_permissions`:

| column | meaning |
|---|---|
| `user_id` | user the rule applies to |
| `capability` | key declared in code, e.g. `spaces.delegate_access` |
| `subject` | optional target, e.g. an integration name; `''` when none |
| `effect` | `allow` or `deny` |
| `granted_by`, `granted_at` | admin user id, unix seconds |

Primary key `(user_id, capability, subject)`. Today only general rules
(`subject = ''`) exist; subject precedence is added with the first capability
that uses a subject.

Capabilities are declared in code with a default, a label and a description.
`spaces.delegate_access` defaults to **deny**. Unknown keys are rejected on
write and never grant on read.

`can(userId, capability)` is the only check: the user's row decides, else the
declared default. It reads the database on every call: no cache, so a revoke
takes effect on the next call.

The admin UI sets a capability to **Allow** or back to **Default**. Admin
writes are audited as `ADMIN_PERMISSION_SET` and `ADMIN_PERMISSION_CLEAR`.

Relation to existing controls: the instance-wide integration switch is checked
first (off for everyone wins). `ADMIN_EMAILS` stays separate: admins edit
permissions, they are not one. `user_permissions` is included in the
SQLite-to-PostgreSQL migration table list.

### Per-Space setting

New columns on `spaces`:
- `access_mode`: `'viewer'` (default, today's behaviour) or `'owner'`.
- `delegated_tools_hash`: `toolsHash(tools)` recorded when the owner enabled
  or last re-confirmed delegation; null otherwise.

Enabling (`access_mode = 'owner'`) requires all of:
- the request comes from the **portal session** (not an API key or OAuth
  agent token);
- `can(owner, "spaces.delegate_access")`;
- the audience is `org` or `users`.

Otherwise `DELEGATION_NOT_ALLOWED` (or `DELEGATION_PORTAL_ONLY` for an agent
credential). Re-saving with delegation on re-records `delegated_tools_hash`
(that is the re-confirm).

Agent tools (`deploy_space`, `update_space`) accept `delegate_access: false`
only; `true` returns `DELEGATION_PORTAL_ONLY`. `list_spaces` returns
`delegate_access` and `delegation_suspended`.

Mode changes:
- Audience set to Only me, by any path (portal PATCH, `update_space`,
  `deploy_space` redeploy): `access_mode` resets to `'viewer'` in the same
  write, audited with the reason.
- Redeploy without `delegate_access`: keeps the current mode (unless private).
- Tool list changed while delegated: mode stays `'owner'` but the Space is
  **suspended** (`toolsHash(tools) !== delegated_tools_hash`) until the owner
  re-confirms in the portal.
- Permission revoked by an admin: mode stays `'owner'`, every call fails with
  `DELEGATION_OFF`, never falls back to the viewer. Re-granting resumes it.

## 2. Call path

`POST /api/spaces/:name/call` keeps its existing order and adds checks:

1. Access (audience).
2. **Consent** to the current tool list **and** access mode **and** owner:
   the consent hash is `sha256(toolsHash, access_mode, owner_id)`. Any flip of
   the mode re-asks every viewer (copy names the owner when delegated).
3. Tool declared by the Space.
4. Tool exists and is enabled.
5. **Delegation valid** (only when `access_mode = 'owner'`): audience not
   private; owner row exists and is not disabled; `can(owner,
   "spaces.delegate_access")`; tool list unchanged since enable
   (`delegated_tools_hash`); tool is not `delegable: false`. Otherwise
   `403 DELEGATION_OFF` (or `TOOL_NOT_DELEGABLE`).
6. Destructive confirmation (dialog names the owner when delegated).
7. Args: no vault references.
8. Rate limit: per viewer (60/min) as today, plus a bucket per (owner, Space)
   of **300/min** so many viewers cannot exhaust the owner's upstream quota.
   Both are per process, like the existing bucket.
9. Run: `executeSingle(runAs, ..., { actorUserId })` where `runAs` is the owner
   when delegated. With an actor set: audit rows carry it, request log lines
   carry it, and cookie auto-reconnect is skipped.

Refusals in steps 5 and 8 write an `EXECUTE` audit row with `success: false`,
the error code, and both people, so "every call is audited" holds for refused
calls too.

Failures never fall back to the viewer's own access:

| case | response |
|---|---|
| permission revoked, owner missing or disabled, tool list changed | `403 DELEGATION_OFF` (message says which, without leaking detail beyond "turned off" / "tools changed") |
| tool marked not delegable | `403 TOOL_NOT_DELEGABLE` |
| owner not connected / refresh failed / cookie session expired | `409 NOT_CONNECTED` with `delegated: true` and the owner's email; no connect action for the viewer |

Unchanged: per-viewer KV stays per viewer. The `connected` flag in the Space
detail reflects the owner's connections when delegated. `source_ip` and
`user_agent` on a delegated row are the viewer's (the request's), which is
correct and documented.

## 3. Audit and Activity

One row per call. `audit_log` gains nullable `actor_user_id`, `actor_email`
plus an index on `(actor_user_id, created_at)`:

- `user_id` / `user_email`: whose access ran (the owner when delegated).
- `actor_user_id` / `actor_email`: who triggered it; null for ordinary calls.
- Space: already in `client_name = "space:<name>"`.
- "Delegated" is derived (`actor_user_id IS NOT NULL`), not stored.

Activity for a user returns rows where `user_id = me OR actor_user_id = me`,
labelled by direction ("X used your access via S" / "You used Y's access via
S"). The OR predicate sorts per page; acceptable at Activity volumes, noted in
code. Admin views show both names and the email filter matches either.
Counts stay one row per call; the per-user summary keeps counting calls on
your own access. The Kafka/stdout event and the request log lines carry the
actor. Payload capture is unchanged and admin-only.

Setting changes are audited: `ADMIN_PERMISSION_SET`, `ADMIN_PERMISSION_CLEAR`,
`SPACE_DELEGATION_ON` (also on re-confirm), `SPACE_DELEGATION_OFF` (with the
reason when forced by an audience change or redeploy).

## 4. UI

- **Admin > Users** (`components/admin/UsersTab.tsx`): per-user Permissions
  panel, one row per declared capability, Allow / Default, "granted by, on".
  Revoke confirms with the number of the user's delegated Spaces. Needs a new
  `GET /api/admin/users/:id/permissions` (there is no user-detail API today).
- **Sharing modal**: "Delegate my access" switch, hidden without the
  permission, disabled on Only me. Enabling lists **every** declared tool
  ("Viewers can call these with your access, with any input") and needs a
  second confirmation. When suspended, the modal says "The tool list changed.
  Review and confirm to resume." with the same confirmation.
- **Spaces list**: "Delegated" badge ("Delegated, paused" when suspended).
- **Viewer**: consent copy "These tools run with <owner>'s access, not yours";
  bar label "Using <owner>'s delegated access"; destructive dialog "Run <tool>
  as <owner>?"; errors for turned-off, tools-changed, not-delegable and
  owner-not-connected, with no connect button.
- **Activity**: "Delegated" tag with the other person and direction.
- **Agent tools**: `delegate_access: false` accepted, `true` refused with
  `DELEGATION_PORTAL_ONLY`; `HOW_TO_BUILD` text updated (no longer "always
  the viewer's connections"; lists the new error codes).

UI ships as a prototype (screenshots) for review before the real components.

## 5. Testing

- Permissions: default, allow, clear back to default, unknown capability
  rejected on write and false on read, no caching, admin writes audited.
- Sharing rules: enable only from a portal session, only when granted, only
  for org/users; agent `true` refused; private (any path, including redeploy)
  resets; mode-only change is written; redeploy keeps mode; re-confirm
  records the new hash.
- Consent: mode flip (either way) returns `CONSENT_REQUIRED`.
- Call path: an OAuth fixture returns the token it was given; seed distinct
  owner and viewer tokens and assert the owner's is used, and that with the
  owner disconnected the call is 409 even though the viewer has a token (no
  fallback); revoked, missing owner, disabled owner, tools changed,
  not-delegable each refused and audited with both ids; destructive still
  needs confirmation; vault refs refused; cookie auto-reconnect not attempted
  when delegated; owner bucket; KV isolation; non-delegated Spaces unchanged.
- Audit: delegated row has both ids; request log line has the actor; Activity
  visible to owner and viewer, not a third user; admin counts not doubled;
  migration on SQLite and PostgreSQL; `migrate/plan.ts` copies
  `user_permissions`.
- Portal: switch states, full tool list warning, suspended state, viewer
  banner and dialogs, admin permission toggle and revoke confirmation.

## Order of work

1. Permission layer, audit columns, spaces columns, call path (server,
   test-first).
2. UI prototype screenshots for review.
3. Real UI, findings doc, PR.
