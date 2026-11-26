# Delegated access for Spaces: what it lends and how it is held

**Date:** 2026-11-26

## Problem

A Space runs every tool call with the viewer's own connections. That is the
right default, but it rules out the most asked-for kind of Space: a team page
over data only its owner can reach (a dashboard over the owner's project
tracker, a status page over the owner's CI). "Delegate my access" lets the
owner switch a shared Space so every call runs with the owner's connections.

Lending credentials to other people is easy to get subtly wrong. These are
the decisions that were not obvious, and why each one went the way it did.
User-facing behaviour is in
[Spaces: Delegated access](../integrations/spaces.md#delegated-access).

## What is actually lent

The first draft of the warning said viewers could "use this Space". That
undersells it. A viewer holds a portal session and can `POST
/api/spaces/:name/call` directly: the page's code does not constrain the
arguments, and `confirmed` (the destructive-call confirmation) is just a body
field. So delegation lends **every declared tool, with any input**, and the
enable dialog lists every declared tool, reads included, and says exactly
that. Anything narrower would be a promise the server does not keep.

## A generic permission store, not a flag

Who may delegate is an admin grant, stored in a new `user_permissions` table
(`user_id`, `capability`, `subject`, `effect`, `granted_by`, `granted_at`)
read through `can(userId, capability)`. Capabilities are declared in code with
a default (`spaces.delegate_access` defaults to deny); a key not declared is
never granted, whatever rows exist. Only the opposite of the default can be
written, so a row always means "an admin changed this". `subject` is reserved
for per-resource rules and is `''` today. It is read on every call, uncached,
so a revoke takes effect at once on every worker. A `users.can_delegate`
column would have been one more one-off; the next per-user switch now costs a
line in `capabilities.ts`.

## One co-owned audit row

A delegated call writes one `audit_log` row: `user_id` is whose access ran
(the owner), `actor_user_id` is who triggered it (the viewer). Two rows, one
per person, would double every admin count and make it ambiguous which one is
the call. Each person's Activity query is `user_id = ? OR actor_user_id = ?`,
and the row is labelled from the reader's side (`for_me`: someone used my
access; `by_me`: I used someone else's), naming the other person by email,
never by id. Refusals from the delegation check onward are audited the same
way, so "every call is audited" also holds for calls that did not run.

## No fallback to the viewer

When delegation is on but cannot run (permission revoked, owner disabled or
deleted, Space made private, tool list changed), the call is refused with
`DELEGATION_OFF`. It never silently runs with the viewer's own access instead:
the viewer approved "this runs as the owner", and a fallback would run the
same page against different data, or with powers the viewer did not mean to
use here. Likewise an owner connection that is missing or dead is `409
NOT_CONNECTED` with `delegated: true` even when the viewer has their own
connection to that app. The tests seed distinct owner and viewer tokens to
prove which one was sent.

## Consent is bound to the mode and the owner, except for the owner

A viewer's consent hash covers the tool list, the access mode and the owner,
so turning delegation on or off (or a change of owner) asks every viewer
again: "runs as me" and "runs as the owner" are different things to agree to.
The owner's own calls always run as the owner, so for the owner the hash is
the tool list alone. Without that exemption the owner was sent back to the
consent screen of their own Space every time they flipped the switch.

## Only the owner, in the portal, for a reviewed list

The dangerous actor here is the owner's own agent. An agent that reads a
prompt-injected issue could otherwise call `update_space` to add a write tool
and turn delegation on, lending the owner's access to everyone in the org.
So:

- **Portal only.** `deploy_space` and `update_space` refuse `delegate_access:
  true` with `DELEGATION_PORTAL_ONLY`. `false` is accepted: turning it off is
  always safe.
- **Widening is portal-only too.** Lending to more people is the same act as
  lending in the first place, so while delegation is on the agent tools
  refuse any change that widens the audience (specific people to everyone
  signed in, or anyone new on a specific-people list, through `add_users`, a
  `users` replace or a redeploy) with `DELEGATION_PORTAL_ONLY`, before any
  write. Narrowing stays open to the agent; the portal's widen asks for the
  same second confirmation as turning it on.
- **Pinned to the reviewed list.** The portal sends back the `tools_hash` of
  the list the owner was shown. Enabling records it as
  `delegated_tools_hash`. Any later change to the tool list (an agent
  redeploy included) pauses delegation (`DELEGATION_OFF`, reason
  `tools_changed`) until the owner confirms the new list in the portal; a
  redeploy that restores the confirmed list resumes it.
- **Compare-and-set on the whole row.** `updateSpaceMeta` writes with a
  `WHERE` on every field it rewrites (`title`, `description`, `tools`,
  `visibility`, `access_mode`, `delegated_tools_hash`, nullable ones through
  `COALESCE` so it is portable to both backends). A redeploy racing the
  owner's confirm loses one side cleanly (`409 CONFLICT`, or `409
  TOOLS_CHANGED` when the confirmed hash no longer matches both the stored and
  the resulting list) instead of pinning a list the owner never saw.

## `delegable: false`

Some tools change the connection they run on, for example a tool that
rewrites its own stored credential. Run with someone else's access, that
would let a viewer change the owner's connection itself. A tool can declare
`delegable: false`; it is refused in delegated mode with
`TOOL_NOT_DELEGABLE`, and the owner's tool list marks it "Owner only".

## One entry point that carries an actor

`executeSingle` runs a tool as a user. Rather than give it an "on behalf of"
option every caller could pass, delegated calls go through `executeDelegated`,
the only function that runs with an actor. It drops everything that would act
for the owner beyond the call itself:

- **No vault.** Nothing is looked up or substituted (Space calls already refuse
  vault references).
- **No custom-app fallback.** Custom apps cannot be declared by a Space anyway,
  and a delegated call does not look for one.
- **No cookie auto-reconnect.** It would type the owner's stored login into the
  owner's browser because a viewer clicked something. The viewer gets "<owner>
  needs to reconnect <app>" instead.

A token refresh on expiry or 401 still happens: it renews the same grant and
is audited as the owner.

## The owner's rate bucket is per process

Besides each viewer's 60 calls a minute per Space, all viewers together share
300 calls a minute per Space against the owner's connections, so a busy Space
cannot exhaust the owner's upstream quota. Like the viewer bucket it is an
in-memory token bucket, so under `CLUSTER_ENABLED` or several replicas the
effective limit is that number per process. A shared counter would need a
database round trip on every call; the bound it gives is still a bound.

## Follow-up

`migrate/plan.ts` (the SQLite to PostgreSQL copy) copies `user_permissions`
but still has no entries for the spaces tables, which predate this change.
