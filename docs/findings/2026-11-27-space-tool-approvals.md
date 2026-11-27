# Space tool approvals: Always allow and Ask first

**Date:** 2026-11-27

## Problem

Inside a Space, whether a call asked first depended only on the tool's effect:
writes ran, destructive and unlabelled tools asked every time. People could
not change that. A viewer who wanted a write to ask, or who used a destructive
tool all day, had no control. Each non-read tool now has a mode, **Always
allow** (`auto`) or **Ask first** (`ask`), with today's behaviour as the
default. User-facing behaviour is in
[Spaces: Tool approvals](../integrations/spaces.md#tool-approvals).

The mechanics are easy. These are the decisions that were not obvious, and
why each went the way it did.

## Stored delegation decides whose policy, not in-effect delegation

A viewer of a delegated Space follows the owner's modes. "Delegated for this
viewer" is read from the **stored** access mode (`owner`, caller not the
owner), the same field the consent hash and the consent POST use, not from
whether delegation is in effect right now. In effect depends on the owner's
permission, their account and a live tool-list check, so using it would need
a permission lookup on every approval read, and it would flip the policy
source while delegation is merely paused: a paused Space would briefly hand
viewers their own modes, which they could then widen with nothing to stop
them. With the stored mode, a paused or blocked Space still refuses calls
with `DELEGATION_OFF`, the owner's policy still applies, and `PUT
/tool-approvals` still answers `APPROVAL_SET_BY_OWNER`. Only an explicit
turn-off (stored mode `viewer`, which also changes the consent hash) gives
viewers ordinary rules again.

## Loosening re-asks, tightening does not, and consent stores the set

The consent hash cannot carry the owner's modes: a tighten would re-ask every
viewer for something that only makes them safer. Instead a delegated viewer's
consent row stores `auto_tools`, the delegable non-read tools that ran
without asking on the screen they approved, and `hasConsent` requires the
current auto set to be a subset of it. A shrinking set stays approved at
once; a tool that gains `auto` (a loosen, or a plugin update that
reclassifies a tool) is missing from the set, so the call answers
`CONSENT_REQUIRED` and the portal says why (`reconsent_reason: "approvals"`
against `"tools"` for a list change). Ordinary viewers and the owner skip the
check and leave `auto_tools` NULL: their modes are their own and can change a
second later in View tools, so binding consent to them protects nothing.

The set that is stored must be the set that was checked. The consent POST
reads the policy once, compares the shown hash with the auto set computed from
that read, and hands the same set to `grantConsent`. Re-reading at insert
would let an owner's loosening that lands between the check and the insert be
recorded as approved, which is exactly the thing the screen did not show. For
the same reason a delegated viewer's `consent_hash` covers the auto set, so a
change between loading the screen and clicking Approve is `CONSENT_CHANGED`.
Everyone else's hash is unchanged.

## One policy read per request

A request reads the approval rows once and uses that result for every check:
the consent test and the ask test in the call route, the hash check and the
grant in the consent POST, the tool list in the detail GET. Two reads can
straddle a policy change and mix old and new, for example a call that passes
the consent check against the old set and the ask check against the new one.

## Backfill needs the registry, so it runs after `loadPlugins`

Delegated consents given before `auto_tools` existed approved the defaults,
meaning the Space's write tools. Turning that into concrete names needs the
tool effects, which come from the plugin registry, so the backfill runs once
at startup after plugins load, not as a migration. It is idempotent: a guarded
`UPDATE ... WHERE auto_tools IS NULL` means every worker may run it and they
write the same thing. A row read before the pass reached it is treated the
same way, so a Space is never briefly more permissive than what was approved.
Later reclassifications are then compared against names, not a moving
definition of "write".

## Always allow widens what a page swap can do

A redeploy that changes only the page files leaves the tool list, and so the
consent hash, unchanged: nobody approves again. Before this change the
destructive confirmation was the one guard that survived a page swap. A
viewer who sets a destructive tool to Always allow lets new page code, written
by the owner's agent, call it in a loop with the viewer's own access, bounded
only by the rate limit (60 a minute per viewer and Space, and 300 for the
owner's bucket when delegated) and the audit log. That is the accepted cost,
and the consent screen copy for Allow all says so. Rows are keyed by tool
name and survive a tool leaving and returning, so an agent that re-adds a
tool the owner once set to auto brings it back as auto; the tool-list change
already makes everyone approve again and both screens show the mode.

## Portal only, because an agent writes Spaces

Spaces are written by agents, and the page is agent-written code, so neither
path may grant itself silent calls. The route lives under the `/api/spaces`
scope, which accepts only a portal session. `deploy_space` and `update_space`
take no approval parameter and never write, reset or delete rows, and the
bridge has no approval message: the page can only send `call`, and the shell
builds the body, so a page-supplied `confirmed` never reaches the server.

## As built

- `PUT /tool-approvals` validates the whole body before the delegated check,
  so a delegated viewer who sends an invalid body gets 400 `INVALID_APPROVAL`
  and one who sends a valid body gets 403 `APPROVAL_SET_BY_OWNER`. Nothing is
  written either way.
- The audit row for an owner's change lists the changes sorted by tool name.
  An unavailable or internal tool in the body is `INVALID_APPROVAL`.
- A missing tool carries `approval: "ask"` and `approvalEditable: false` in
  the list; read tools carry neither.
- Writes set to Ask first count toward the five-confirmations-in-ten-seconds
  pause, which is that guard doing its job. Calls that run without asking do
  not.
- `space_tool_approvals` is created with `CREATE TABLE IF NOT EXISTS` on both
  backends and is not in `migrate/plan.ts`, like the other Space tables.
