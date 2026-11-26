# Space delegated access ("Delegate my access")

Status: approved design, not yet implemented.

## Problem

A Space runs every tool call with the **viewer's** own connections. A viewer
who has not connected (or cannot connect) a tool the Space uses sees nothing
from it. Owners want to share a Space whose data comes from **their** access,
so people without that tool can still use it.

This lends one person's credentials to others, so it is admin-gated, scoped to
the Space's declared tools, and every call is audited under both people.

## Summary

- Sharing keeps its three audiences: Only me, Specific people, Everyone signed
  in. A separate per-Space switch, **Delegate my access**, makes tool calls run
  with the owner's connections instead of the viewer's.
- Viewers always sign in. The switch only applies to Specific people and
  Everyone signed in.
- Only owners an admin has granted `spaces.delegate_access` can turn it on.
- Reads and writes follow the Space's declared tools, exactly as today.
  Destructive tools still confirm every call.
- One audit row per call names both the owner (whose access ran) and the
  viewer (who triggered it). Both see it in their Activity.

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

Primary key `(user_id, capability, subject)`: one rule per target.

Capabilities are declared in code with a default, a label and a description.
`spaces.delegate_access` defaults to **deny**; a future `integration.use`
would default to **allow**. Unknown keys are rejected on write.

`can(userId, capability, subject?)` is the only check. An exact
`(capability, subject)` row decides; otherwise a `(capability, '')` row;
otherwise the declared default. It reads the database on every call: no cache,
so a revoke takes effect on the next call.

Relation to existing controls: the instance-wide integration switch is checked
first (off for everyone wins). `ADMIN_EMAILS` stays separate: admins edit
permissions, they are not one.

### Per-Space setting

`spaces.access_mode`: `'viewer'` (default, today's behaviour) or `'owner'`.

The owner may set `'owner'` only when `can(owner, "spaces.delegate_access")`
and the audience is `org` or `users`; otherwise `DELEGATION_NOT_ALLOWED`.
Enforced on the server for both the portal API and the agent tools.

- Audience changed to Only me: `access_mode` is reset to `'viewer'` in the
  same write, and the reset is audited.
- Specific people to Everyone signed in while delegated: allowed; the portal
  warns before saving; audited.
- Permission revoked by an admin: `access_mode` stays `'owner'`, every call
  fails with `DELEGATION_OFF`, never falls back to the viewer. Re-granting
  resumes it.

## 2. Call path

`POST /api/spaces/:name/call` keeps its existing order and adds a delegation
check before running:

1. Access (audience).
2. Consent to the current tool list (consent copy names the owner when
   delegated).
3. Tool declared by the Space. This is the scope boundary: only declared tools
   are reachable through delegation.
4. Tool exists and is enabled.
5. **Delegation valid** (only when `access_mode = 'owner'`): audience is not
   private, `can(owner, "spaces.delegate_access")`, owner not disabled.
   Otherwise `403 DELEGATION_OFF`.
6. Destructive confirmation (dialog names the owner when delegated).
7. Args: no vault references (so the owner's vault is never reachable).
8. Rate limit: per viewer as today, plus a shared bucket per (owner, Space) so
   many viewers cannot exhaust the owner's upstream quota.
9. Run: `executeSingle(runAs, ...)` where `runAs` is the owner when
   delegated, the viewer otherwise; the audit context records the viewer as
   actor.

Failures never fall back to the viewer's own access:

| case | response |
|---|---|
| permission revoked, owner disabled | `403 DELEGATION_OFF` |
| owner not connected / refresh failed | `409 NOT_CONNECTED` with `delegated: true` and the owner's display email; no connect action for the viewer |

Unchanged: per-viewer KV stays per viewer (delegation lends tool access, not
storage). The `connected` flag in the Space detail reflects the owner's
connections when delegated. A future per-user `integration.use` deny is
checked against both the owner and the viewer.

## 3. Audit and Activity

One row per call. `audit_log` gains nullable `actor_user_id`, `actor_email`
plus an index on `actor_user_id`:

- `user_id` / `user_email`: whose access ran (the owner when delegated).
- `actor_user_id` / `actor_email`: who triggered it; null for ordinary calls.
- Space: already in `client_name = "space:<name>"`.
- "Delegated" is derived (`actor_user_id IS NOT NULL`), not stored.

Activity for a user returns rows where `user_id = me OR actor_user_id = me`,
labelled by direction ("X used your access via S" / "You used Y's access via
S"), with a Delegated filter. Admin views show both names and filter by
either; counts stay one row per call. The Kafka/stdout event carries both
pairs. Payload capture is unchanged and remains admin-only.

Setting changes are audited as actions: `PERMISSION_GRANT`,
`PERMISSION_REVOKE`, `SPACE_DELEGATION_ON`, `SPACE_DELEGATION_OFF` (with the
reason when forced by an audience change), and audience changes on a
delegated Space.

## 4. UI

- **Admin > Users > user > Permissions**: one row per declared capability,
  Allow/Deny toggle, default shown, "granted by, on". Revoke confirms with the
  number of the user's delegated Spaces that will stop working for viewers.
- **Sharing modal**: "Delegate my access" switch, hidden without the
  permission, disabled on Only me. Turning it on lists the Space's write tools
  and needs a second confirmation; widening the audience while delegated
  repeats the warning.
- **Spaces list**: "Delegated" badge.
- **Viewer**: consent copy "These tools run with <owner>'s access, not yours";
  persistent bar label "Using <owner>'s delegated access"; destructive dialog
  "Run <tool> as <owner>?"; errors for turned-off and owner-not-connected with
  no connect button.
- **Activity**: Delegated tag with the other person, filter chip.
- **Agent tools**: `deploy_space` / `update_space` accept `delegate_access`;
  `list_spaces` returns it. Same server checks.

UI ships as a prototype (screenshots) for review before the real components.

## 5. Testing

- Permissions: defaults, subject-specific beats general, deny vs allow on the
  same key, unknown capability rejected, no caching, grant/revoke audited.
- Sharing rules: enable only when granted and audience is org/users (portal
  API and `update_space`); private audience resets it; agent cannot enable it
  for an ungranted owner.
- Call path: runs with the owner's token, never the viewer's; undeclared tool
  and vault refs refused; revoked, disabled, not-connected, refresh-failed each
  error with no fallback; destructive confirmation still required; shared
  owner rate bucket; KV isolation; non-delegated Spaces unchanged.
- Audit: one row with both ids; visible to owner and viewer, not to a third
  user; admin counts not doubled; Kafka event carries both; migration on
  SQLite and PostgreSQL.
- Portal: switch visibility and states, write-tool warning, viewer banner and
  dialogs, admin permission toggle and revoke confirmation.

## Order of work

1. Permission layer, audit migration, call path (server, test-first).
2. UI prototype screenshots for review.
3. Real UI, findings doc, PR.
