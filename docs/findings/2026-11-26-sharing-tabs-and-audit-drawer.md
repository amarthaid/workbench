# Sharing tabs, blocked delegation and the audit filters

Findings from reworking the Space Sharing dialog and the Activity views.

## A missing permission is a flag, not a rewrite of the stored setting

The first design reported `delegate_access` as "effective" (stored mode owner
AND the owner holds `spaces.delegate_access`). A review against the code showed
that this removes two safety paths. The dialog derives `wasOn`, the widening
review and the turn-off payload from `delegate_access`, so a blocked owner could
no longer turn the stored mode off and the widening review was skipped. An admin
re-allow would then lend the owner's access to a wider audience, unreviewed.
The MCP Space tools also already define `delegate_access` as stored and
`delegation_active` as in effect, so one name would have meant two things.

Now `delegate_access` stays as stored and the owner's responses add
`delegation_blocked: "no_permission"`. The portal hides the tab strip and shows
a Turn off button. The server turns the stored mode off, with an audit row and
the reason "audience widened without permission", when a PATCH widens the
audience while the owner is blocked. A people-only edit changes nothing stored,
so a re-allow restores delegation as stored.

## The 90-day cap does not protect the admin query without an index

`audit_log` had no index leading on `created_at`. A `since`/`until` admin query
planned as a full scan plus a temporary sort. `idx_audit_created ON
audit_log (created_at, id)` fixes it (and makes this a release candidate: a
schema change). The personal query was already fine: its `user_id = ? OR
actor_user_id = ?` scope uses `idx_audit_user` and `idx_audit_actor_nn` with the
date bounds pushed in. Callers that send no `since` (the home cards, agents)
keep their old behaviour; the cap applies only when a range is sent.

## The person filter must match what the row shows

Rows display `COALESCE(users.email, recorded email)`. Matching the raw recorded
columns would return nothing for a suggestion after an email change, so the
person filter and the people endpoint use the same expression. The filter is
always ANDed inside the reader's own scope, so it cannot reach other people's
rows.

## Another person's origin stays on the server

On a call someone else made through your Space, the request origin (IP address,
user agent, credential and client name) is that person's data. The personal
endpoint returns those four fields as null on those rows; the drawer shows a
note instead. Hiding them in the page alone would still have sent them over the
wire.

## Search boxes that do not hammer the database

The email and person boxes fetch one capped list and filter it in the browser,
so typing makes no request. The admin Space search cannot (the list can be
huge): it waits for 2 characters and a 250 ms pause, aborts a superseded
request, caches per query, and the server answers with a `LIKE` prefix and title
match over the small `spaces` table, `limit+1` rows for `has_more`, no count.
A `name >= q AND name < q || high` prefix range was tried first (it is index
friendly) and failed on PostgreSQL: the comparison follows the column collation,
which ignores punctuation in locale collations, so `rep_` did not find
`rep_live` and `rel` missed `release-notes`. SQLite tests alone passed. Filters are a draft until Apply, so none of this touches the audit
table while typing.
